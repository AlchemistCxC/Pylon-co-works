//! JsDriver：跨平台兜底路径的页面脚本与解析。
//!
//! 所有脚本都遵循既有 `eval_json` 契约：IIFE 返回 `JSON.stringify(...)` 字符串。
//! 枚举/重查/高亮脚本保持纯函数可测（script builder + parse 分离）。

use super::SnapshotElement;
use crate::browser::agent::refs::{js_text_fingerprint, RefTarget};

/// 单轮枚举可交互元素：role/name/中心点/选择器链/指纹。
/// 无名 generic 跳过；布局外（display:none / 零尺寸）跳过；
/// 视口外的可见元素保留（点击前会 scrollIntoView 重查）。
pub(crate) const ENUMERATE_SCRIPT: &str = r#"(() => {
  const MAX = 400;
  const selectorFor = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const nameAttr = el.getAttribute('name');
    const tag = el.tagName.toLowerCase();
    if (nameAttr) return tag + '[name="' + nameAttr + '"]';
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 4) {
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ') || tag;
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary' || tag === 'details') return 'button';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    if (el.getAttribute('onclick') || (el.getAttribute('tabindex') && el.getAttribute('tabindex') !== '-1')) return 'generic';
    return 'generic';
  };
  const nameOf = (el) => (
    el.getAttribute('aria-label')
    || el.innerText
    || (el.value && String(el.value))
    || el.getAttribute('placeholder')
    || el.getAttribute('title')
    || el.getAttribute('alt')
    || ''
  ).trim().replace(/\s+/g, ' ').slice(0, 120);
  const selector = 'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[role="switch"],[role="option"],[role="textbox"],[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"])';
  const results = [];
  for (const el of document.querySelectorAll(selector)) {
    if (results.length >= MAX) break;
    if (el.getClientRects().length === 0) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    const role = roleOf(el);
    const name = nameOf(el);
    if (role === 'generic' && !name) continue;
    results.push({
      role,
      name,
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      selector: selectorFor(el),
      href: role === 'link' ? (el.href || null) : null,
    });
  }
  return JSON.stringify({
    url: window.location.href,
    title: document.title || null,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    text: (document.body && document.body.innerText || '').slice(0, 20000),
    elements: results,
  });
})()"#;

/// 解析枚举结果：元素列表 + ref 注册表 target 序列（含文本指纹）。
pub(crate) fn parse_enumeration(
    raw: &serde_json::Value,
) -> Result<(Vec<SnapshotElement>, Vec<RefTarget>), String> {
    let elements = raw
        .get("elements")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "枚举结果缺少 elements 数组".to_string())?;
    let mut snapshots = Vec::with_capacity(elements.len());
    let mut targets = Vec::with_capacity(elements.len());
    for element in elements {
        let role = text(element, "role").ok_or("元素缺少 role")?;
        let name = text(element, "name").unwrap_or_default();
        let selector = text(element, "selector").ok_or("元素缺少 selector")?;
        let x = number(element, "x").ok_or("元素缺少 x")?;
        let y = number(element, "y").ok_or("元素缺少 y")?;
        let href = text(element, "href");
        let fingerprint = js_text_fingerprint(&name);
        snapshots.push(SnapshotElement {
            reference: String::new(),
            role,
            name: name.clone(),
            x,
            y,
            selector: selector.clone(),
            href,
        });
        targets.push(RefTarget::Js {
            selector,
            name,
            fingerprint,
            center_x: x,
            center_y: y,
        });
    }
    Ok((snapshots, targets))
}

/// 点击前重查：滚动元素进入视口并复核指纹，返回可信派发/合成点击所需的最新中心点。
/// 指纹不匹配返回 `stale_ref`——调用方提示 agent 重新 snapshot。
pub(crate) const VERIFY_AND_CENTER_SCRIPT: &str = r#"(() => {
  const selector = SELECTOR_PLACEHOLDER;
  const expected = EXPECTED_PLACEHOLDER;
  const norm = (value) => (value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  let el;
  try { el = document.querySelector(selector); } catch (_) { el = null; }
  if (!el) return JSON.stringify({ ok: false, code: 'stale_ref', reason: '元素不在文档中（页面可能已变化）' });
  const nameOf = (node) => (
    node.getAttribute('aria-label')
    || node.innerText
    || (node.value && String(node.value))
    || node.getAttribute('placeholder')
    || node.getAttribute('title')
    || node.getAttribute('alt')
    || ''
  ).trim().replace(/\s+/g, ' ').slice(0, 120);
  const name = nameOf(el);
  if (expected && norm(name) !== norm(expected)) {
    return JSON.stringify({ ok: false, code: 'stale_ref', reason: '元素文本已变化（now=' + name.slice(0, 40) + '）' });
  }
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  const rect = el.getBoundingClientRect();
  return JSON.stringify({
    ok: true,
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    tag: el.tagName.toLowerCase(),
    name,
    href: (el.matches('a[href]') && el.href) || null,
    opensTab: el.matches('a[href]')
      && (el.getAttribute('target') || '').toLowerCase() !== '_self'
      && !(el.getAttribute('href') || '').startsWith('#')
      && !el.hasAttribute('download'),
  });
})()"#;

/// 用 JSON 字面量替换脚本里的占位符（避免手拼引号）。`expected_name` 传快照时
/// 的原始可见名，JS 侧对两侧都做归一化后比较（注册表里的哈希仅用于 Rust 侧）。
pub(crate) fn build_verify_script(selector: &str, expected_name: &str) -> String {
    let selector_json = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".to_string());
    let expected_json = serde_json::to_string(expected_name).unwrap_or_else(|_| "\"\"".to_string());
    VERIFY_AND_CENTER_SCRIPT
        .replace("SELECTOR_PLACEHOLDER", &selector_json)
        .replace("EXPECTED_PLACEHOLDER", &expected_json)
}

/// 解析重查结果：`{ok, code?, x?, y?, tag?, name?, href?, opensTab?}`。
pub(crate) fn parse_verify(raw: &serde_json::Value) -> Result<serde_json::Value, String> {
    let ok = raw.get("ok").and_then(serde_json::Value::as_bool);
    match ok {
        Some(true) => Ok(raw.clone()),
        Some(false) => {
            let code = text(raw, "code").unwrap_or_else(|| "stale_ref".to_string());
            Err(code)
        }
        None => Err("重查结果缺少 ok 字段".to_string()),
    }
}

/// agent 操作瞬间的高亮：目标矩形描边 + 序号角标，约 1.2s 后自清。
pub(crate) const HIGHLIGHT_SCRIPT: &str = r#"(() => {
  const selector = SELECTOR_PLACEHOLDER;
  let el;
  try { el = document.querySelector(selector); } catch (_) { el = null; }
  if (!el) return JSON.stringify({ ok: false });
  const rect = el.getBoundingClientRect();
  const marker = '__PYLON_AGENT_HIGHLIGHT__';
  document.querySelectorAll('[' + marker + ']').forEach((node) => node.remove());
  const box = document.createElement('div');
  box.setAttribute(marker, '1');
  box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;'
    + 'left:' + (rect.left - 3) + 'px;top:' + (rect.top - 3) + 'px;'
    + 'width:' + (rect.width + 6) + 'px;height:' + (rect.height + 6) + 'px;'
    + 'border:2px solid #d97706;border-radius:4px;background:rgba(217,119,6,0.14);'
    + 'box-shadow:0 0 0 9999px rgba(0,0,0,0.08);transition:opacity .3s;';
  document.body.appendChild(box);
  setTimeout(() => { box.style.opacity = '0'; }, 900);
  setTimeout(() => { box.remove(); }, 1200);
  return JSON.stringify({ ok: true });
})()"#;

pub(crate) fn build_highlight_script(selector: &str) -> String {
    let selector_json = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".to_string());
    HIGHLIGHT_SCRIPT.replace("SELECTOR_PLACEHOLDER", &selector_json)
}

/// `browser_wait {until:'selector'}` 的轮询脚本。
pub(crate) fn build_selector_present_script(selector: &str) -> String {
    let selector_json = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"(() => {{ let ok = false; try {{ ok = !!document.querySelector({selector_json}); }} catch (_) {{ ok = false; }} return JSON.stringify({{ ok }}); }})()"#
    )
}

/// `browser_wait {until:'load'}` 的轮询脚本。
pub(crate) const READY_STATE_SCRIPT: &str =
    r#"(() => JSON.stringify({ readyState: document.readyState }))()"#;

fn text(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

fn number(value: &serde_json::Value, key: &str) -> Option<f64> {
    value.get(key).and_then(serde_json::Value::as_f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enumerate_script_has_balanced_braces_and_no_placeholder_leak() {
        assert!(!ENUMERATE_SCRIPT.contains("PLACEHOLDER"));
        assert_eq!(
            ENUMERATE_SCRIPT.matches('{').count(),
            ENUMERATE_SCRIPT.matches('}').count()
        );
        assert!(ENUMERATE_SCRIPT.contains("JSON.stringify"));
    }

    #[test]
    fn build_verify_script_embeds_json_literals() {
        let script = build_verify_script("#submit \"特殊\"", "提交 表单");
        assert!(script.contains("\"#submit \\\"特殊\\\"\""));
        assert!(script.contains("\"提交 表单\""));
        assert!(!script.contains("SELECTOR_PLACEHOLDER"));
        assert!(!script.contains("EXPECTED_PLACEHOLDER"));
    }

    #[test]
    fn parse_enumeration_builds_targets_with_fingerprint() {
        let raw = serde_json::json!({
            "elements": [
                { "role": "button", "name": "提交 表单", "x": 10, "y": 20, "selector": "#s", "href": null },
                { "role": "link", "name": "首页", "x": 1, "y": 2, "selector": "a:nth-of-type(1)", "href": "https://example.com" },
            ]
        });
        let (snapshots, targets) = parse_enumeration(&raw).unwrap();
        assert_eq!(snapshots.len(), 2);
        assert_eq!(snapshots[0].reference, "");
        assert_eq!(snapshots[0].name, "提交 表单");
        assert!(snapshots[1].href.is_some());
        match &targets[0] {
            RefTarget::Js {
                selector,
                name,
                fingerprint,
                center_x,
                center_y,
            } => {
                assert_eq!(selector, "#s");
                assert_eq!(name, "提交 表单");
                assert_eq!(*fingerprint, js_text_fingerprint("提交 表单"));
                assert_eq!(*center_x, 10.0);
                assert_eq!(*center_y, 20.0);
            }
            other => panic!("应为 Js target：{other:?}"),
        }
    }

    #[test]
    fn parse_enumeration_rejects_missing_fields() {
        assert!(parse_enumeration(&serde_json::json!({})).is_err());
        assert!(
            parse_enumeration(&serde_json::json!({ "elements": [{ "role": "button" }] })).is_err()
        );
    }

    #[test]
    fn parse_verify_maps_stale_ref() {
        let ok = parse_verify(&serde_json::json!({ "ok": true, "x": 3, "y": 4 })).unwrap();
        assert_eq!(ok.get("x").and_then(serde_json::Value::as_f64), Some(3.0));
        let stale =
            parse_verify(&serde_json::json!({ "ok": false, "code": "stale_ref" })).unwrap_err();
        assert_eq!(stale, "stale_ref");
        assert!(parse_verify(&serde_json::json!({})).is_err());
    }

    #[test]
    fn highlight_and_selector_scripts_are_json_safe() {
        let highlight = build_highlight_script("div[title=\"a'b\"]");
        assert!(!highlight.contains("SELECTOR_PLACEHOLDER"));
        let selector_script = build_selector_present_script("a[href^=\"https://\"]");
        assert!(!selector_script.contains("SELECTOR_PLACEHOLDER"));
        assert!(READY_STATE_SCRIPT.contains("readyState"));
    }
}
