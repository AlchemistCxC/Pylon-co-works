//! 工具入参读取。
//!
//! MCP 的 `tools/call` 把参数作为任意 JSON 给我们；按字段名的类型化读取集中在这里，
//! 保证「类型不对」与「字段缺失」都变成带工具名的 `BadArgs`，而不是 panic 或静默默认。

use serde_json::Value;

use crate::error::{Error, Result};

pub struct Args<'a> {
    tool: &'a str,
    value: &'a Value,
}

impl<'a> Args<'a> {
    pub fn new(tool: &'a str, value: &'a Value) -> Self {
        Self { tool, value }
    }

    pub fn raw(&self) -> &'a Value {
        self.value
    }

    fn get(&self, key: &str) -> Option<&'a Value> {
        match self.value {
            Value::Object(map) => map.get(key).filter(|v| !v.is_null()),
            _ => None,
        }
    }

    fn type_error<T>(&self, key: &str, expected: &str) -> Result<T> {
        Err(Error::bad_args(
            self.tool,
            format!(
                "字段 `{key}` 应为 {expected}，实际收到 {}",
                self.get(key).map(short_type).unwrap_or("nothing")
            ),
        ))
    }

    pub fn str(&self, key: &str) -> Result<Option<&'a str>> {
        match self.get(key) {
            None => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.as_str())),
            Some(_) => self.type_error(key, "字符串"),
        }
    }

    pub fn string(&self, key: &str) -> Result<Option<String>> {
        Ok(self.str(key)?.map(str::to_string))
    }

    /// 必填字符串：缺失与类型错都报错。
    pub fn required_str(&self, key: &str) -> Result<&'a str> {
        self.str(key)?
            .ok_or_else(|| Error::bad_args(self.tool, format!("缺少必填字段 `{key}`（字符串）")))
    }

    pub fn u64(&self, key: &str) -> Result<Option<u64>> {
        match self.get(key) {
            None => Ok(None),
            Some(Value::Number(n)) => n
                .as_u64()
                .map(Some)
                .ok_or_else(|| Error::bad_args(self.tool, format!("字段 `{key}` 应为非负整数"))),
            Some(_) => self.type_error(key, "非负整数"),
        }
    }

    pub fn f64(&self, key: &str) -> Result<Option<f64>> {
        match self.get(key) {
            None => Ok(None),
            Some(Value::Number(n)) => n
                .as_f64()
                .map(Some)
                .ok_or_else(|| Error::bad_args(self.tool, format!("字段 `{key}` 应为数字"))),
            Some(_) => self.type_error(key, "数字"),
        }
    }

    pub fn bool(&self, key: &str) -> Result<Option<bool>> {
        match self.get(key) {
            None => Ok(None),
            Some(Value::Bool(b)) => Ok(Some(*b)),
            Some(_) => self.type_error(key, "布尔"),
        }
    }

    pub fn bool_or(&self, key: &str, default: bool) -> Result<bool> {
        Ok(self.bool(key)?.unwrap_or(default))
    }

    pub fn u64_or(&self, key: &str, default: u64) -> Result<u64> {
        Ok(self.u64(key)?.unwrap_or(default))
    }

    /// 字符串数组。同时接受单个字符串（`"error"` 与 `["error"]` 等价），
    /// 因为 LLM 经常在这两种写法间摇摆，为此报错只是浪费一轮。
    pub fn str_list(&self, key: &str) -> Result<Vec<String>> {
        match self.get(key) {
            None => Ok(Vec::new()),
            Some(Value::String(s)) => Ok(vec![s.clone()]),
            Some(Value::Array(items)) => {
                let mut out = Vec::with_capacity(items.len());
                for (i, item) in items.iter().enumerate() {
                    match item {
                        Value::String(s) => out.push(s.clone()),
                        _ => {
                            return Err(Error::bad_args(
                                self.tool,
                                format!("字段 `{key}[{i}]` 应为字符串"),
                            ))
                        }
                    }
                }
                Ok(out)
            }
            Some(_) => self.type_error(key, "字符串或字符串数组"),
        }
    }
}

fn short_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "布尔",
        Value::Number(_) => "数字",
        Value::String(_) => "字符串",
        Value::Array(_) => "数组",
        Value::Object(_) => "对象",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn missing_required_field_names_the_tool() {
        let value = json!({});
        let args = Args::new("webview_click", &value);
        let error = args.required_str("selector").unwrap_err();
        assert_eq!(error.kind(), "bad_args");
        assert!(error.to_string().contains("webview_click"));
        assert!(error.to_string().contains("selector"));
    }

    #[test]
    fn null_is_treated_as_absent_not_as_type_error() {
        let value = json!({ "limit": null, "selector": null });
        let args = Args::new("t", &value);
        assert_eq!(args.u64("limit").unwrap(), None);
        assert_eq!(args.str("selector").unwrap(), None);
    }

    #[test]
    fn wrong_type_reports_actual_type() {
        let value = json!({ "limit": "50" });
        let args = Args::new("webview_console", &value);
        let error = args.u64("limit").unwrap_err();
        assert!(error.to_string().contains("字符串"), "{error}");
    }

    #[test]
    fn str_list_accepts_bare_string() {
        let value = json!({ "events": "session://update" });
        let args = Args::new("tauri_events", &value);
        assert_eq!(args.str_list("events").unwrap(), vec!["session://update"]);
    }

    #[test]
    fn str_list_rejects_mixed_array_with_index() {
        let value = json!({ "events": ["ok", 7] });
        let args = Args::new("tauri_events", &value);
        let error = args.str_list("events").unwrap_err();
        assert!(error.to_string().contains("events[1]"), "{error}");
    }
}
