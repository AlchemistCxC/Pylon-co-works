//! ref 注册表：把页面快照里的稳定元素引用（`e1`、`e12`…）映射回可操作的定位。
//!
//! 双型定位：CdpDriver 用 backendNodeId（AX 树锚点，CSP 无关）；JsDriver 用
//! 选择器链 + 文本指纹（操作前重查校验）。导航即整表失效（`stale_ref` 语义
//! 与 Playwright MCP 一致：提示 agent 重新 snapshot）。

use std::collections::HashMap;

/// 每个 tab 最多缓存的 ref 数；超出的元素不出现在快照结果里。
pub(crate) const MAX_REFS_PER_TAB: usize = 400;

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum RefTarget {
    /// CdpDriver：AX 节点的 backendNodeId + 元素中心点（CSS 像素）。
    /// （快照当前统一走 JS 枚举；AX 树路径预留，见开发记录偏差说明。）
    #[allow(dead_code)]
    Cdp {
        backend_node_id: i64,
        center_x: f64,
        center_y: f64,
    },
    /// JsDriver：选择器 + 可见名（重查归一化比对用）+ 指纹（注册表去重用）+ 中心点。
    Js {
        selector: String,
        name: String,
        fingerprint: String,
        center_x: f64,
        center_y: f64,
    },
}

#[derive(Debug, Default)]
pub(crate) struct RefRegistry {
    /// tab_id →（按快照顺序的 ref 列表）。Vec 顺序即分配顺序，ref 名可由下标重建。
    by_tab: HashMap<u64, Vec<RefTarget>>,
}

impl RefRegistry {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// 用一次快照的元素序列整体替换该 tab 的注册表，返回分配的 ref 名（与输入同序）。
    /// 超出 [`MAX_REFS_PER_TAB`] 的尾部元素被截断。
    pub(crate) fn replace_tab(
        &mut self,
        tab_id: u64,
        targets: impl IntoIterator<Item = RefTarget>,
    ) -> Vec<String> {
        let targets: Vec<RefTarget> = targets.into_iter().take(MAX_REFS_PER_TAB).collect();
        let refs: Vec<String> = (0..targets.len()).map(ref_name).collect();
        self.by_tab.insert(tab_id, targets);
        refs
    }

    pub(crate) fn resolve(&self, tab_id: u64, reference: &str) -> Option<&RefTarget> {
        let index = ref_index(reference)?;
        self.by_tab.get(&tab_id)?.get(index)
    }

    pub(crate) fn invalidate_tab(&mut self, tab_id: u64) {
        self.by_tab.remove(&tab_id);
    }

    #[allow(dead_code)] // 测试与调试用
    pub(crate) fn len(&self, tab_id: u64) -> usize {
        self.by_tab.get(&tab_id).map_or(0, Vec::len)
    }

    #[allow(dead_code)] // 测试用
    pub(crate) fn is_empty(&self) -> bool {
        self.by_tab.is_empty()
    }
}

/// ref 名 ↔ 下标：`e1` 起步，纯下标编解码，无随机性（可测试、可回放）。
pub(crate) fn ref_name(index: usize) -> String {
    format!("e{}", index + 1)
}

pub(crate) fn ref_index(reference: &str) -> Option<usize> {
    let digits = reference.strip_prefix('e')?;
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let index: usize = digits.parse().ok()?;
    index.checked_sub(1)
}

/// JsDriver 的文本指纹：可见名归一化（小写、压空白）后的短哈希。
/// 操作前用同规则重查元素文本，不一致判 `stale_ref`。
pub(crate) fn js_text_fingerprint(text: &str) -> String {
    let normalized: String = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    // FNV-1a 64：无需引入哈希 crate，指纹用途不要求抗碰撞。
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in normalized.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_targets(count: usize) -> Vec<RefTarget> {
        (0..count)
            .map(|index| RefTarget::Js {
                selector: format!("#el-{index}"),
                name: format!("按钮{index}"),
                fingerprint: js_text_fingerprint(&format!("按钮{index}")),
                center_x: index as f64,
                center_y: 0.0,
            })
            .collect()
    }

    #[test]
    fn ref_name_and_index_roundtrip() {
        assert_eq!(ref_name(0), "e1");
        assert_eq!(ref_name(399), "e400");
        for index in [0usize, 1, 42, 399] {
            assert_eq!(ref_index(&ref_name(index)), Some(index));
        }
        assert_eq!(ref_index("e0"), None);
        assert_eq!(ref_index("x1"), None);
        assert_eq!(ref_index("e"), None);
        assert_eq!(ref_index("e1x"), None);
        assert_eq!(ref_index("e999999999999999999999"), None);
    }

    #[test]
    fn replace_tab_allocates_sequential_refs_and_resolves() {
        let mut registry = RefRegistry::new();
        let refs = registry.replace_tab(7, sample_targets(3));
        assert_eq!(refs, vec!["e1", "e2", "e3"]);
        assert_eq!(registry.len(7), 3);
        let target = registry.resolve(7, "e2").unwrap();
        match target {
            RefTarget::Js { selector, .. } => assert_eq!(selector, "#el-1"),
            other => panic!("应为 Js 型 target，实际 {other:?}"),
        }
        assert!(registry.resolve(7, "e4").is_none());
        assert!(registry.resolve(8, "e1").is_none());
    }

    #[test]
    fn replace_tab_caps_at_limit() {
        let mut registry = RefRegistry::new();
        let refs = registry.replace_tab(1, sample_targets(MAX_REFS_PER_TAB + 50));
        assert_eq!(refs.len(), MAX_REFS_PER_TAB);
        assert_eq!(registry.len(1), MAX_REFS_PER_TAB);
    }

    #[test]
    fn invalidate_tab_clears_resolution() {
        let mut registry = RefRegistry::new();
        registry.replace_tab(3, sample_targets(2));
        registry.invalidate_tab(3);
        assert_eq!(registry.len(3), 0);
        assert!(registry.resolve(3, "e1").is_none());
    }

    #[test]
    fn js_fingerprint_is_whitespace_collapse_and_case_insensitive() {
        // 与 VERIFY_AND_CENTER_SCRIPT 的 JS 归一化同语义：trim + 压缩连续空白 + 小写。
        let base = js_text_fingerprint("提交 表单");
        assert_eq!(base, js_text_fingerprint("  提交   表单 "));
        assert_eq!(base, js_text_fingerprint("提交 表单"));
        assert_ne!(
            base,
            js_text_fingerprint("提交表单"),
            "内部单空格不去除（与 JS 侧一致）"
        );
        assert_ne!(base, js_text_fingerprint("提交 表单!"));
        // 大小写不敏感。
        assert_eq!(
            js_text_fingerprint("Submit OK"),
            js_text_fingerprint("submit ok")
        );
    }
}
