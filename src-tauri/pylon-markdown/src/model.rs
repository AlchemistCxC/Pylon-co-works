//! 渲染模型——与 TS 基线 `markdownRenderModel.ts` 的 `MarkdownRenderNode` 同形状。
//!
//! TS 侧形状（unified → remark-rehype 的 hast 投影，经 `normalizeNode` 收敛）只有三种节点：
//! `root` / `element`（`tagName` + `properties` + `children`）/ `text`（`value`）。
//! 本类型用 serde 产出**逐字段同名**的 JSON（`type`/`tagName`/`properties`/`children`/`value`），
//! 这是 WP4 parity 的比对面：两侧 JSON 深相等即为一致。
//!
//! 为什么 `properties` 用 `BTreeMap`：hast 属性语义上无序，快照文件要稳定（diff 友好），
//! 故按键排序序列化；TS 侧对象键序不参与深比较，两侧无序差异不影响 parity。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// hast 属性值：字符串 / 布尔 / 数字 / 数组（hast 规范允许的四类）。
///
/// `List` 放在最前：serde untagged 按声明顺序尝试，数组必须先于标量匹配，
/// 否则会被误判成标量失败。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PropValue {
    List(Vec<PropValue>),
    Str(String),
    Num(i64),
    Bool(bool),
}

impl PropValue {
    pub fn str(value: impl Into<String>) -> Self {
        PropValue::Str(value.into())
    }
}

/// 渲染模型节点（`MarkdownRenderNode` 的 Rust 镜像）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum RenderNode {
    Root {
        children: Vec<RenderNode>,
    },
    Element {
        #[serde(rename = "tagName")]
        tag_name: String,
        properties: BTreeMap<String, PropValue>,
        children: Vec<RenderNode>,
    },
    Text {
        value: String,
    },
}

impl RenderNode {
    pub fn root(children: Vec<RenderNode>) -> Self {
        RenderNode::Root { children }
    }

    pub fn element(tag_name: impl Into<String>, children: Vec<RenderNode>) -> Self {
        RenderNode::Element {
            tag_name: tag_name.into(),
            properties: BTreeMap::new(),
            children,
        }
    }

    pub fn element_with(
        tag_name: impl Into<String>,
        properties: BTreeMap<String, PropValue>,
        children: Vec<RenderNode>,
    ) -> Self {
        RenderNode::Element {
            tag_name: tag_name.into(),
            properties,
            children,
        }
    }

    pub fn text(value: impl Into<String>) -> Self {
        RenderNode::Text {
            value: value.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// serde 形状契约：字段名必须与 TS 侧逐一同名（`tagName` 是 camelCase），
    /// 这是 parity 比对面的根基，锁死防漂移。
    #[test]
    fn serializes_with_ts_field_names() {
        let mut properties = BTreeMap::new();
        properties.insert("href".to_string(), PropValue::str("https://x"));
        properties.insert("checked".to_string(), PropValue::Bool(true));
        let node = RenderNode::root(vec![
            RenderNode::element_with("a", properties, vec![RenderNode::text("link")]),
            RenderNode::text("tail"),
        ]);
        let json = serde_json::to_value(&node).unwrap();
        let object = json.as_object().unwrap();
        assert_eq!(object.get("type").and_then(|v| v.as_str()), Some("root"));

        let first = json["children"][0].as_object().unwrap();
        assert_eq!(first.get("type").and_then(|v| v.as_str()), Some("element"));
        assert_eq!(first.get("tagName").and_then(|v| v.as_str()), Some("a"));
        assert!(first.get("properties").is_some());
        assert!(first.get("children").is_some());

        let second = json["children"][1].as_object().unwrap();
        assert_eq!(second.get("type").and_then(|v| v.as_str()), Some("text"));
        assert_eq!(second.get("value").and_then(|v| v.as_str()), Some("tail"));
    }

    /// 属性值四类的往返：数组、字符串、数字、布尔都要无损。
    #[test]
    fn property_values_round_trip() {
        let mut properties = BTreeMap::new();
        properties.insert(
            "className".to_string(),
            PropValue::List(vec![PropValue::str("language-rust")]),
        );
        properties.insert("start".to_string(), PropValue::Num(5));
        properties.insert("disabled".to_string(), PropValue::Bool(true));
        let node = RenderNode::element_with("code", properties, vec![]);
        let json = serde_json::to_string(&node).unwrap();
        let back: RenderNode = serde_json::from_str(&json).unwrap();
        assert_eq!(back, node);
        // 数字必须落成整数 JSON（TS number 深比较按值，"5.0" 形状会引入假差异）。
        assert!(json.contains("\"start\":5"));
    }
}
