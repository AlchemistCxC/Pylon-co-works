//! 注入页面的 JS 片段构造。
//!
//! 两点设计约束：
//!
//! 1. **不用 `format!`**。这些模板里 JS 花括号远多于占位符，逐个转义成 `{{`/`}}`
//!    是纯手工风险。改用 [`render`]：单趟扫描 + 最长 key 优先，
//!    既不会出现部分匹配（`A` 吃掉 `AB` 的前缀），也不会二次替换
//!    （替换进去的值里若含占位符字样不会被再展开）。
//! 2. **所有外部字符串都过 [`js_str`]**。JSON 字符串字面量是合法 JS 字符串字面量，
//!    且 `serde_json` 已经处理了引号/反斜杠/控制字符，比手写转义可靠。

use serde_json::Value;

/// 单趟占位符插值。
pub fn render(template: &str, bindings: &[(&str, String)]) -> String {
    // 最长 key 优先，否则 `{A}` 会先吃掉 `{AB}` 的前两个字符。
    let mut ordered: Vec<&(&str, String)> = bindings.iter().collect();
    ordered.sort_by_key(|(key, _)| std::cmp::Reverse(key.len()));

    let mut out = String::with_capacity(template.len() + 64);
    let mut rest = template;
    'scan: while !rest.is_empty() {
        for (key, value) in &ordered {
            if let Some(tail) = rest.strip_prefix(*key) {
                out.push_str(value);
                rest = tail;
                continue 'scan;
            }
        }
        match rest.chars().next() {
            Some(ch) => {
                out.push(ch);
                rest = &rest[ch.len_utf8()..];
            }
            None => break,
        }
    }
    out
}

/// Rust 字符串 → JS 字符串字面量。
pub fn js_str(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

/// Rust `Value` → JS 字面量。
pub fn js_value(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

/// 可选 selector → JS 字面量（`null` 表示「不限定」）。
pub fn js_optional_str(value: Option<&str>) -> String {
    match value {
        Some(text) => js_str(text),
        None => "null".to_string(),
    }
}

/// 把用户表达式包成可直接 `await` 的异步 IIFE。
///
/// `return (` 之后**必须换行**再闭合：表达式末尾若带 `//` 行注释，
/// 同行闭合会把 `);` 一起注释掉，整个片段变成语法错误。
pub fn as_async_expression(expression: &str, wrap: bool) -> String {
    if !wrap {
        return expression.to_string();
    }
    render(
        "(async () => {\n  return (\n{EXPRESSION}\n  );\n})()",
        &[("{EXPRESSION}", expression.to_string())],
    )
}

/// 与 [`as_async_expression`] 相反：包成异步 IIFE 但不 `return`，
/// 用于「执行一段语句并自行 return 结果对象」的场合。
pub fn as_async_body(body: &str) -> String {
    render(
        "(async () => {\n{BODY}\n})()",
        &[("{BODY}", body.to_string())],
    )
}

/// 同步 IIFE。用于纯取值，不涉及 Promise。
pub fn as_sync_body(body: &str) -> String {
    render("(() => {\n{BODY}\n})()", &[("{BODY}", body.to_string())])
}

/// DOM 结构轮廓。
///
/// 走 `Runtime.evaluate` 递归序列化，而不是 `DOM.getDocument` + 逐节点
/// `DOM.describeNode`：后者每个节点一次往返，一个中等页面就是几百次；
/// 而且 `DOM.*` 的 nodeId 会被任何 DOM 变更作废，agent 拿着旧 id 调用只会收到
/// "Could not find node"。自序列化一次性拿到全部，且没有句柄失效问题。
pub fn dom_outline(
    selector: Option<&str>,
    max_depth: usize,
    max_nodes: usize,
    include_text: bool,
    include_rect: bool,
) -> String {
    as_sync_body(&render(
        r#"
  const SCOPE = {SCOPE};
  const MAX_DEPTH = {MAX_DEPTH};
  const MAX_NODES = {MAX_NODES};
  const INCLUDE_TEXT = {INCLUDE_TEXT};
  const INCLUDE_RECT = {INCLUDE_RECT};
  const CLIP = 240;

  const root = SCOPE === null ? document.documentElement : document.querySelector(SCOPE);
  if (!root) return { found: false, reason: 'selector 未命中任何元素', selector: SCOPE };

  let visited = 0;
  const clip = (text) => {
    const value = String(text);
    return value.length > CLIP ? value.slice(0, CLIP) + '…' : value;
  };
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };

  const walk = (el, depth) => {
    if (visited >= MAX_NODES) return null;
    visited += 1;
    const node = { tag: el.tagName.toLowerCase() };
    if (el.id) node.id = el.id;
    const className = (el.getAttribute('class') || '').trim();
    if (className) node.class = clip(className);

    const attrs = {};
    for (const attr of el.attributes) {
      if (attr.name === 'class' || attr.name === 'id') continue;
      attrs[attr.name] = clip(attr.value);
    }
    if (Object.keys(attrs).length) node.attrs = attrs;

    if (INCLUDE_RECT) node.rect = rectOf(el);

    if (INCLUDE_TEXT && el.children.length === 0) {
      const text = (el.textContent || '').trim();
      if (text) node.text = clip(text);
    }

    const childCount = el.children.length;
    if (depth < MAX_DEPTH && childCount) {
      const children = [];
      for (const child of el.children) {
        const serialized = walk(child, depth + 1);
        if (serialized) children.push(serialized);
        else break;
      }
      if (children.length) node.children = children;
      if (children.length < childCount) node.elidedChildren = childCount - children.length;
    } else if (childCount) {
      node.elidedChildren = childCount;
    }
    return node;
  };

  const tree = walk(root, 0);
  return {
    found: true,
    visited,
    truncated: visited >= MAX_NODES,
    maxDepth: MAX_DEPTH,
    tree,
  };
"#,
        &[
            ("{MAX_DEPTH}", max_depth.to_string()),
            ("{MAX_NODES}", max_nodes.to_string()),
            ("{INCLUDE_TEXT}", include_text.to_string()),
            ("{INCLUDE_RECT}", include_rect.to_string()),
            ("{SCOPE}", js_optional_str(selector)),
        ],
    ))
}

/// 单元素详查：盒模型、计算样式、可见性、祖先链。
pub fn query_element(selector: &str, properties: &[String]) -> String {
    let props: Vec<String> = properties.iter().map(|p| js_str(p)).collect();
    as_sync_body(&render(
        r#"
  const SELECTOR = {SELECTOR};
  const PROPS = [{PROPS}];

  const el = document.querySelector(SELECTOR);
  if (!el) return { found: false, selector: SELECTOR };

  const describe = (node) => {
    if (!node || node.nodeType !== 1) return null;
    const cls = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
    return node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + cls.map((c) => '.' + c).join('');
  };

  const computed = {};
  const style = getComputedStyle(el);
  for (const name of PROPS) computed[name] = style.getPropertyValue(name);

  const rect = el.getBoundingClientRect();
  const visible = typeof el.checkVisibility === 'function'
    ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    : (rect.width > 0 && rect.height > 0);

  const attrs = {};
  for (const attr of el.attributes) attrs[attr.name] = attr.value;

  const ancestors = [];
  let cursor = el.parentElement;
  while (cursor && ancestors.length < 10) { ancestors.push(describe(cursor)); cursor = cursor.parentElement; }

  const html = el.innerHTML;
  return {
    found: true,
    selector: SELECTOR,
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    path: describe(el),
    classes: Array.from(el.classList || []),
    attrs,
    text: (el.textContent || '').trim().slice(0, 800),
    value: ('value' in el && el.value !== undefined) ? String(el.value).slice(0, 800) : null,
    innerHTMLPreview: html.length > 1200 ? html.slice(0, 1200) + '…' : html,
    visible,
    disabled: !!el.disabled,
    rect: {
      x: rect.x, y: rect.y, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left,
      width: rect.width, height: rect.height,
    },
    scroll: {
      top: el.scrollTop, left: el.scrollLeft,
      height: el.scrollHeight, width: el.scrollWidth,
      clientHeight: el.clientHeight, clientWidth: el.clientWidth,
    },
    computed,
    ancestors,
  };
"#,
        &[
            ("{SELECTOR}", js_str(selector)),
            ("{PROPS}", props.join(", ")),
        ],
    ))
}

/// 把目标元素滚进视口并算出可点击的中心点，同时做命中测试。
///
/// `hitIsSelfOrDescendant === false` 是排障时最有价值的信号：
/// 说明该点被别的元素盖住了，`Input.dispatchMouseEvent` 会打到覆盖物上——
/// 这类「点了没反应」靠 `element.click()` 是查不出来的。
pub fn resolve_click_target(selector: &str) -> String {
    as_sync_body(&render(
        r#"
  const SELECTOR = {SELECTOR};
  const el = document.querySelector(SELECTOR);
  if (!el) return { found: false, selector: SELECTOR };

  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });

  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const hit = document.elementFromPoint(x, y);

  return {
    found: true,
    selector: SELECTOR,
    x, y,
    width: rect.width,
    height: rect.height,
    inViewport: rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth,
    pointerEvents: style.pointerEvents,
    visibility: style.visibility,
    display: style.display,
    disabled: !!el.disabled,
    hitTag: hit ? hit.tagName.toLowerCase() : null,
    hitPath: hit ? (hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '')) : null,
    hitIsSelfOrDescendant: hit ? (el === hit || el.contains(hit)) : false,
  };
"#,
        &[("{SELECTOR}", js_str(selector))],
    ))
}

/// 聚焦输入目标，可选先清空。
///
/// 「清空」走 DOM 赋值 + 派发 `input` 事件，而不是全选后覆盖：
/// 受控组件（Solid/React 的受控输入）只有收到 `input` 才会同步内部状态，
/// 只改 `value` 会让 UI 与状态脱节，后续输入的行文也会错位。
pub fn focus_for_typing(selector: Option<&str>, clear: bool) -> String {
    as_sync_body(&render(
        r#"
  const SELECTOR = {SELECTOR};
  const CLEAR = {CLEAR};

  const el = SELECTOR === null ? document.activeElement : document.querySelector(SELECTOR);
  if (!el) return { found: false, selector: SELECTOR, reason: SELECTOR === null ? '当前没有聚焦元素' : 'selector 未命中' };

  if (typeof el.focus === 'function') el.focus();

  const before = ('value' in el && el.value !== undefined) ? String(el.value) : null;

  let cleared = false;
  if (CLEAR) {
    if ('value' in el && typeof el.value === 'string') {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      cleared = true;
    } else if (el.isContentEditable) {
      el.textContent = '';
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      cleared = true;
    }
  }

  return {
    found: true,
    selector: SELECTOR,
    tag: el.tagName.toLowerCase(),
    isContentEditable: !!el.isContentEditable,
    readOnly: !!el.readOnly,
    disabled: !!el.disabled,
    focused: document.activeElement === el,
    valueBefore: before,
    valueAfter: ('value' in el && el.value !== undefined) ? String(el.value) : null,
    cleared,
  };
"#,
        &[
            ("{SELECTOR}", js_optional_str(selector)),
            ("{CLEAR}", clear.to_string()),
        ],
    ))
}

/// 窗口状态：Tauri 宿主侧（权威）与 DOM 侧（兜底）两组。
///
/// 宿主侧命令全部走 `plugin:window|*`，且都带 `label`。
/// 每个调用独立 try/catch —— 权限或平台不支持时只让该字段变成 `{error}`，
/// 不能让整张状态表失败。
pub fn window_state(fallback_label: &str) -> String {
    as_async_body(&render(
        r#"
  const FALLBACK_LABEL = {FALLBACK_LABEL};
  const internals = window.__TAURI_INTERNALS__;
  const meta = internals && internals.metadata;
  const label = (meta && meta.currentWindow && meta.currentWindow.label) || FALLBACK_LABEL;

  const tryInvoke = async (command) => {
    if (!internals || typeof internals.invoke !== 'function') {
      return { error: 'window.__TAURI_INTERNALS__.invoke 不存在：该页面不是 Tauri webview' };
    }
    try {
      return { value: await internals.invoke(command, { label }) };
    } catch (error) {
      const message = (error && error.message) ? error.message : String(error);
      return { error: message };
    }
  };

  const COMMANDS = [
    'scale_factor', 'inner_size', 'outer_size', 'inner_position', 'outer_position',
    'is_maximized', 'is_minimized', 'is_fullscreen', 'is_focused', 'is_decorated',
    'is_visible', 'is_resizable', 'is_closable', 'is_always_on_top',
    'title', 'theme', 'available_monitors', 'current_monitor', 'cursor_position'
  ];

  const results = await Promise.all(COMMANDS.map((command) => tryInvoke('plugin:window|' + command)));

  const host = {};
  const hostErrors = {};
  COMMANDS.forEach((command, index) => {
    const result = results[index];
    if (result && Object.prototype.hasOwnProperty.call(result, 'value')) host[command] = result.value;
    else hostErrors[command] = result ? result.error : 'unknown';
  });

  return {
    windowLabel: label,
    windowLabelSource: (meta && meta.currentWindow && meta.currentWindow.label) ? 'tauri-metadata' : 'fallback',
    tauriHost: host,
    tauriHostErrors: hostErrors,
    tauriHostAvailable: Object.keys(host).length > 0,
    dom: {
      href: location.href,
      documentTitle: document.title,
      readyState: document.readyState,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      screenX: window.screenX,
      screenY: window.screenY,
      devicePixelRatio: window.devicePixelRatio,
      visibilityState: document.visibilityState,
      isFullscreenElement: !!document.fullscreenElement,
      hasFocus: document.hasFocus(),
      scrollY: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
    },
  };
"#,
        &[("{FALLBACK_LABEL}", js_str(fallback_label))],
    ))
}

/// 调用任意已注册的 Tauri 命令。
///
/// 错误路径刻意保留原始形态：Tauri 的 `Result<_, PylonError>` 里 `Err` 侧
/// 可能是字符串也可能是对象（取决于 `PylonError` 的 Serialize 实现），
/// 所以既给人类可读的 `error`，也给 `errorRaw` 的 JSON 形态 —— 猜错一种会让
/// 排障多绕一轮。
pub fn tauri_invoke(command: &str, args: &Value) -> String {
    as_async_body(&render(
        r#"
  const COMMAND = {COMMAND};
  const ARGS = {ARGS};
  const internals = window.__TAURI_INTERNALS__;

  if (!internals || typeof internals.invoke !== 'function') {
    return { ok: false, error: 'window.__TAURI_INTERNALS__.invoke 不存在：该页面不是 Tauri webview' };
  }

  try {
    const value = await internals.invoke(COMMAND, ARGS);
    return { ok: true, value: value === undefined ? null : value };
  } catch (error) {
    let message;
    if (error && error.message) message = error.message;
    else if (typeof error === 'string') message = error;
    else message = String(error);

    let raw = null;
    try { raw = JSON.stringify(error); } catch (_) { raw = null; }

    return { ok: false, error: message, errorRaw: raw };
  }
"#,
        &[("{COMMAND}", js_str(command)), ("{ARGS}", js_value(args))],
    ))
}

/// 订阅事件并装入页内环形缓冲。
///
/// **必须显式列出事件名**：`tauri-2.11.5/scripts/core.js` 用
/// `Object.defineProperty(..., 'invoke', { value })` 定义 invoke，
/// 没有 `writable`/`configurable`，因此无法包装 invoke 来旁路捕获
/// `plugin:event|emit`。事件名清单由 `tauri_event_catalog` 从源码静态扫出。
///
/// 订阅状态存在页内（`window.__PYLON_MCP_EVENTS__.subscribed`）而不是 Rust 侧：
/// 页面 reload 会把注册表清空，而 Rust 侧的「已订阅」缓存感知不到这个事实，
/// 只会让后续 drain 永远返回空。以页内为准则天然自愈。
pub fn events_subscribe(
    names: &[String],
    target: &Value,
    max_buffer: usize,
    reset: bool,
) -> String {
    let names: Vec<String> = names.iter().map(|n| js_str(n)).collect();
    as_async_body(&render(
        r#"
  const NAMES = [{NAMES}];
  const TARGET = {TARGET};
  const MAX_BUFFER = {MAX_BUFFER};
  const RESET = {RESET};

  const store = (window.__PYLON_MCP_EVENTS__ = window.__PYLON_MCP_EVENTS__ || {
    seq: 0, buf: [], subscribed: {}, errors: {}, evicted: 0, readCursor: 0
  });
  // 兼容上一版本写入的缺字段对象。
  if (!store.buf) store.buf = [];
  if (!store.subscribed) store.subscribed = {};
  if (!store.errors) store.errors = {};
  if (typeof store.seq !== 'number') store.seq = 0;
  if (typeof store.evicted !== 'number') store.evicted = 0;
  if (typeof store.readCursor !== 'number') store.readCursor = 0;

  if (RESET) {
    store.buf.length = 0;
    store.readCursor = store.seq;
    store.evicted = 0;
  }

  const internals = window.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function') {
    return {
      ok: false,
      reason: 'not-a-tauri-webview',
      detail: 'window.__TAURI_INTERNALS__.invoke 不存在：该页面不是 Tauri webview，或尚未完成初始化',
      subscribed: Object.keys(store.subscribed),
      errors: store.errors,
    };
  }

  const newlySubscribed = [];
  for (const name of NAMES) {
    if (store.subscribed[name]) continue;
    const handlerId = internals.transformCallback((event) => {
      store.buf.push({
        seq: ++store.seq,
        at: Date.now(),
        event: name,
        id: event ? event.id : null,
        payload: event ? event.payload : null,
      });
      while (store.buf.length > MAX_BUFFER) { store.buf.shift(); store.evicted += 1; }
    }, false);
    try {
      await internals.invoke('plugin:event|listen', { event: name, target: TARGET, handler: handlerId });
      store.subscribed[name] = handlerId;
      delete store.errors[name];
      newlySubscribed.push(name);
    } catch (error) {
      // 订阅失败要把已注册的回调撤掉，否则页面里会留下没人调用的死 handler。
      try { internals.unregisterCallback(handlerId); } catch (_) {}
      store.errors[name] = (error && error.message) ? error.message : String(error);
    }
  }

  return {
    ok: true,
    newlySubscribed,
    subscribed: Object.keys(store.subscribed),
    errors: store.errors,
    buffered: store.buf.length,
    evicted: store.evicted,
    latestSeq: store.seq,
  };
"#,
        &[
            ("{NAMES}", names.join(", ")),
            ("{TARGET}", js_value(target)),
            ("{MAX_BUFFER}", max_buffer.to_string()),
            ("{RESET}", reset.to_string()),
        ],
    ))
}

/// 读事件增量，游标语义与 `webview_console` 一致（scan 与 limit 分离）。
pub fn events_drain(since_seq: Option<u64>, scan: usize, limit: usize) -> String {
    let since = match since_seq {
        Some(value) => value.to_string(),
        None => "null".to_string(),
    };
    as_sync_body(&render(
        r#"
  const SINCE = {SINCE};
  const SCAN = {SCAN};
  const LIMIT = {LIMIT};

  const store = window.__PYLON_MCP_EVENTS__;
  if (!store) {
    return {
      installed: false,
      reason: '尚未订阅任何事件；先用 events 参数列出事件名调用本工具',
      entries: [], scanned: 0, cursor: 0, latestSeq: 0, evicted: 0, subscribed: [], errors: {},
    };
  }

  const from = (SINCE === null) ? (store.readCursor || 0) : SINCE;
  const scanned = [];
  for (const entry of store.buf) {
    if (entry.seq <= from) continue;
    if (scanned.length >= SCAN) break;
    scanned.push(entry);
  }

  const entries = scanned.slice(0, LIMIT);
  // 游标推到**扫描**末尾而不是返回末尾：否则被 limit 截掉的尾部会在下轮重放。
  const last = scanned.length ? scanned[scanned.length - 1].seq : from;
  if (SINCE === null) store.readCursor = last;

  return {
    installed: true,
    entries,
    scanned: scanned.length,
    cursor: SINCE === null ? last : from,
    latestSeq: store.seq,
    evicted: store.evicted,
    subscribed: Object.keys(store.subscribed),
    errors: store.errors,
  };
"#,
        &[
            ("{SINCE}", since),
            ("{SCAN}", scan.to_string()),
            ("{LIMIT}", limit.to_string()),
        ],
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn render_prefers_the_longest_key() {
        // `{A}` 是 `{AB}` 的前缀：若按声明顺序匹配，`{AB}` 会被拆成 `{A}` + "B}"。
        let out = render(
            "x {AB} y {A}",
            &[("{A}", "short".into()), ("{AB}", "long".into())],
        );
        assert_eq!(out, "x long y short");
    }

    #[test]
    fn render_does_not_resubstitute_inside_values() {
        // 替换进去的值含有占位符字样时，不得被再次展开。
        let out = render(
            "{A} and {B}",
            &[("{A}", "{B}".into()), ("{B}", "boom".into())],
        );
        assert_eq!(out, "{B} and boom");
    }

    #[test]
    fn render_leaves_unknown_braces_alone() {
        let out = render("if (x) { y(); } {KNOWN}", &[("{KNOWN}", "1".into())]);
        assert_eq!(out, "if (x) { y(); } 1");
    }

    #[test]
    fn js_str_escapes_quotes_backslashes_and_newlines() {
        let literal = js_str("he said \"hi\"\\\n</script>");
        assert!(literal.starts_with('"') && literal.ends_with('"'));
        assert!(!literal.contains('\n'), "{literal}");
        assert!(literal.contains("\\\""));
        assert!(literal.contains("\\\\"));
        // JSON 字面量是合法 JS：可以被 JSON 反解回原串。
        let parsed: String = serde_json::from_str(&literal).unwrap();
        assert_eq!(parsed, "he said \"hi\"\\\n</script>");
    }

    #[test]
    fn optional_selector_becomes_js_null() {
        assert_eq!(js_optional_str(None), "null");
        assert_eq!(js_optional_str(Some("#app")), "\"#app\"");
    }

    #[test]
    fn wrapped_expression_survives_a_trailing_line_comment() {
        // `return (1 // note` 若同行闭合，`);` 会被注释掉 → 语法错误。
        let wrapped = as_async_expression("1 // note", true);
        let close_index = wrapped.rfind(");").expect("wrapper must close");
        let comment_index = wrapped.find("// note").unwrap();
        assert!(close_index > comment_index);
        // 关键：注释与闭合之间必须存在换行。
        assert!(
            wrapped[comment_index..close_index].contains('\n'),
            "{wrapped}"
        );
    }

    #[test]
    fn unwrapped_expression_is_passed_through_verbatim() {
        assert_eq!(as_async_expression("await foo()", false), "await foo()");
    }

    #[test]
    fn dom_outline_embeds_scope_and_limits_as_literals() {
        let script = dom_outline(Some("#app"), 4, 250, true, false);
        assert!(script.contains("const SCOPE = \"#app\";"));
        assert!(script.contains("const MAX_DEPTH = 4;"));
        assert!(script.contains("const MAX_NODES = 250;"));
        assert!(script.contains("const INCLUDE_TEXT = true;"));
        assert!(script.contains("const INCLUDE_RECT = false;"));
        // 未替换的占位符一个都不能剩。
        assert!(!script.contains("{SCOPE}"), "{script}");
    }

    #[test]
    fn dom_outline_without_scope_targets_the_document_element() {
        let script = dom_outline(None, 3, 100, false, true);
        assert!(script.contains("const SCOPE = null;"));
    }

    #[test]
    fn query_element_builds_a_property_literal_list() {
        let script = query_element(".btn", &["display".to_string(), "z-index".to_string()]);
        assert!(
            script.contains("const PROPS = [\"display\", \"z-index\"];"),
            "{script}"
        );
        assert!(script.contains("const SELECTOR = \".btn\";"));
    }

    #[test]
    fn query_element_handles_an_empty_property_list() {
        let script = query_element("#x", &[]);
        assert!(script.contains("const PROPS = [];"), "{script}");
    }

    #[test]
    fn click_target_selector_is_escaped_not_interpolated() {
        // 选择器里带引号必须被转义，不能逃逸成 JS 代码。
        let script = resolve_click_target("a[title=\"x\"]");
        assert!(
            script.contains(r#"const SELECTOR = "a[title=\"x\"]";"#),
            "{script}"
        );
    }

    #[test]
    fn typing_without_selector_falls_back_to_active_element() {
        let script = focus_for_typing(None, true);
        assert!(script.contains("const SELECTOR = null;"));
        assert!(script.contains("const CLEAR = true;"));
    }

    #[test]
    fn window_state_uses_metadata_label_and_falls_back() {
        let script = window_state("main");
        assert!(script.contains("const FALLBACK_LABEL = \"main\";"));
        // 每个宿主命令都必须带 label，否则会命中错误的窗口。
        assert!(script.contains("internals.invoke(command, { label })"));
        assert!(script.contains("plugin:window|"));
    }

    #[test]
    fn tauri_invoke_passes_arguments_as_json() {
        let script = tauri_invoke("list_runtime_logs", &json!({ "query": { "limit": 5 } }));
        assert!(script.contains("const COMMAND = \"list_runtime_logs\";"));
        assert!(
            script.contains(r#"const ARGS = {"query":{"limit":5}};"#),
            "{script}"
        );
    }

    #[test]
    fn tauri_invoke_handles_a_command_name_containing_quotes() {
        let script = tauri_invoke("a\"b", &json!({}));
        assert!(script.contains(r#"const COMMAND = "a\"b";"#), "{script}");
    }

    #[test]
    fn events_subscribe_emits_a_quote_list_and_target_object() {
        let script = events_subscribe(
            &["session://update".to_string(), "pet://tick".to_string()],
            &json!({ "kind": "Any" }),
            500,
            false,
        );
        assert!(
            script.contains(r#"const NAMES = ["session://update", "pet://tick"];"#),
            "{script}"
        );
        assert!(script.contains(r#"const TARGET = {"kind":"Any"};"#));
        assert!(script.contains("const MAX_BUFFER = 500;"));
        assert!(script.contains("const RESET = false;"));
        assert!(script.contains("plugin:event|listen"));
    }

    #[test]
    fn events_subscribe_with_empty_name_list_still_returns_state() {
        let script = events_subscribe(&[], &json!({ "kind": "Any" }), 100, true);
        assert!(script.contains("const NAMES = [];"));
        assert!(script.contains("const RESET = true;"));
    }

    #[test]
    fn events_drain_encodes_auto_cursor_as_null() {
        let auto = events_drain(None, 500, 50);
        assert!(auto.contains("const SINCE = null;"), "{auto}");
        assert!(auto.contains("const SCAN = 500;"));
        assert!(auto.contains("const LIMIT = 50;"));

        let explicit = events_drain(Some(12), 10, 10);
        assert!(explicit.contains("const SINCE = 12;"), "{explicit}");
    }

    #[test]
    fn every_generated_script_is_balanced_enough_to_parse_bracewise() {
        // 轻量守卫：占位符替换后花括号仍应配平（漏替换或误转义会打破它）。
        let scripts = [
            dom_outline(Some("#a"), 2, 10, true, true),
            query_element("#a", &["color".to_string()]),
            resolve_click_target("#a"),
            focus_for_typing(Some("#a"), false),
            focus_for_typing(None, true),
            window_state("main"),
            tauri_invoke("cmd", &json!({})),
            events_subscribe(&["e".to_string()], &json!({ "kind": "Any" }), 10, false),
            events_drain(None, 10, 10),
            events_drain(Some(1), 10, 10),
            as_async_expression("1 + 1", true),
        ];
        for script in scripts {
            let mut depth: i64 = 0;
            let mut in_string: Option<char> = None;
            let mut escaped = false;
            for ch in script.chars() {
                if let Some(quote) = in_string {
                    if escaped {
                        escaped = false;
                    } else if ch == '\\' {
                        escaped = true;
                    } else if ch == quote {
                        in_string = None;
                    }
                    continue;
                }
                match ch {
                    '"' | '\'' | '`' => in_string = Some(ch),
                    '{' => depth += 1,
                    '}' => depth -= 1,
                    _ => {}
                }
                assert!(depth >= 0, "花括号提前闭合：\n{script}");
            }
            assert!(in_string.is_none(), "字符串未闭合：\n{script}");
            assert_eq!(depth, 0, "花括号不配平（{depth}）：\n{script}");
        }
    }
}
