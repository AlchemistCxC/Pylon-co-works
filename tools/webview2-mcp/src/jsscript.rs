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

/// 无障碍快照：把页面折成「角色 + 可访问名 + ref」的文本树。
///
/// 为什么不是 DOM 大纲：驱动 UI 时，agent 需要的是「那个按钮」而不是
/// `div.chat > div:nth-child(3) > button`——选择器依赖结构，页面一改就失效，
/// 而角色 + 名字是用户看到的东西。ref 则是给这份快照里每个节点起的一个短名字，
/// 后续 `webview_click` / `webview_type` 直接用它定位（比选择器稳得多）。
///
/// 角色表是**简化版**：覆盖常见标签与显式 `role=`，不做完整的 ARIA 隐含角色推导。
/// 名字按 aria-label → aria-labelledby → 关联 label → placeholder/alt → 文本
/// 的顺序取。ref 存进 `window.__PYLON_MCP_REFS__`，页面重载即失效——那时
/// 定位会明确报「请重新快照」，而不是悄悄点到别处。
pub fn aria_snapshot(selector: Option<&str>, max_nodes: usize, include_values: bool) -> String {
    as_sync_body(&render(
        r#"
  const SCOPE = {SCOPE};
  const MAX_NODES = {MAX_NODES};
  const INCLUDE_VALUES = {INCLUDE_VALUES};
  const CLIP = 120;

  const root = SCOPE === null ? document.documentElement : document.querySelector(SCOPE);
  if (!root) return { found: false, reason: 'selector 未命中任何元素', selector: SCOPE };

  const clip = (text) => {
    const value = String(text).replace(/\s+/g, ' ').trim();
    return value.length > CLIP ? value.slice(0, CLIP) + '…' : value;
  };
  const visible = (el) => {
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

  const roleOf = (el) => {
    const explicit = (el.getAttribute('role') || '').trim().toLowerCase();
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' || tag === 'area') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden') return null;
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'file' || type === 'color' || type === 'submit' || type === 'reset' ||
          type === 'button' || type === 'image') return 'button';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'option') return 'option';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'img') return 'img';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'li') return 'listitem';
    if (tag === 'table') return 'table';
    if (tag === 'tr') return 'row';
    if (tag === 'td') return 'cell';
    if (tag === 'th') return 'columnheader';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'header') return 'banner';
    if (tag === 'footer') return 'contentinfo';
    if (tag === 'aside') return 'complementary';
    if (tag === 'form') return 'form';
    if (tag === 'dialog') return 'dialog';
    if (tag === 'details' || tag === 'fieldset') return 'group';
    if (tag === 'summary') return 'button';
    if (tag === 'progress') return 'progressbar';
    return null;
  };

  const labeledText = (el) => {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (!labelledBy) return '';
    return labelledBy
      .split(/\s+/)
      .map((id) => {
        const target = document.getElementById(id);
        return target ? textOf(target) : '';
      })
      .join(' ')
      .trim();
  };

  const labelFor = (el) => {
    if (!el.id) return '';
    for (const candidate of document.querySelectorAll('label')) {
      if (candidate.htmlFor === el.id) return textOf(candidate);
    }
    return '';
  };

  const nameOf = (el, role) => {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return clip(ariaLabel);
    const labelled = labeledText(el);
    if (labelled) return clip(labelled);

    const tag = el.tagName.toLowerCase();
    if (tag === 'img') {
      const alt = el.getAttribute('alt');
      if (alt && alt.trim()) return clip(alt);
    }
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      const fromLabel = labelFor(el);
      if (fromLabel) return clip(fromLabel);
      const closest = el.closest('label');
      if (closest) {
        const text = textOf(closest);
        if (text) return clip(text);
      }
      const placeholder = el.getAttribute('placeholder');
      if (placeholder && placeholder.trim()) return clip(placeholder);
    }
    if (['button', 'link', 'heading', 'option', 'tab', 'menuitem', 'menuitemcheckbox',
         'menuitemradio', 'listitem', 'cell', 'columnheader', 'rowheader', 'summary',
         'treeitem'].indexOf(role) !== -1) {
      const text = textOf(el);
      if (text) return clip(text);
    }
    const title = el.getAttribute('title');
    if (title && title.trim()) return clip(title);
    return '';
  };

  const extrasOf = (el, role) => {
    const parts = [];
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') parts.push('disabled');
    if (role === 'checkbox' || role === 'radio' || role === 'switch') {
      parts.push(el.checked ? 'checked' : 'unchecked');
    }
    if (role === 'heading') {
      const match = /^h([1-6])$/.exec(el.tagName.toLowerCase());
      const level = el.getAttribute('aria-level') || (match ? match[1] : '');
      if (level) parts.push('level=' + level);
    }
    const expanded = el.getAttribute('aria-expanded');
    if (expanded) parts.push('expanded=' + expanded);
    const selected = el.getAttribute('aria-selected');
    if (selected) parts.push('selected=' + selected);
    if (INCLUDE_VALUES && (role === 'textbox' || role === 'searchbox' || role === 'combobox')) {
      const value = typeof el.value === 'string' ? el.value : '';
      if (value) parts.push('value=' + JSON.stringify(clip(value)));
    }
    return parts.length ? ' ' + parts.join(' ') : '';
  };

  const refs = {};
  const lines = [];
  let refSeq = 0;
  let truncated = false;

  const walk = (el, depth) => {
    if (truncated) return;
    if (el.nodeType !== 1) return;
    if (el.getAttribute('aria-hidden') === 'true') return;
    if (!visible(el)) return;

    let childDepth = depth;
    const role = roleOf(el);
    if (role) {
      if (refSeq >= MAX_NODES) {
        truncated = true;
        return;
      }
      const ref = 'e' + (++refSeq);
      refs[ref] = el;
      const name = nameOf(el, role);
      lines.push(
        '  '.repeat(depth) + '- ' + role +
        (name ? ' ' + JSON.stringify(name) : '') +
        extrasOf(el, role) +
        ' [ref=' + ref + ']'
      );
      childDepth = depth + 1;
    }
    for (const child of el.children) walk(child, childDepth);
  };

  walk(root, 0);
  window.__PYLON_MCP_REFS__ = { at: Date.now(), refs: refs };

  return {
    found: true,
    scope: SCOPE,
    nodeCount: refSeq,
    truncated: truncated,
    snapshot: lines.join('\n'),
  };
"#,
        &[
            ("{SCOPE}", js_optional_str(selector)),
            ("{MAX_NODES}", max_nodes.to_string()),
            ("{INCLUDE_VALUES}", include_values.to_string()),
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
/// `webview_click` 与 `webview_hover` 共用这份解析。`hitIsSelfOrDescendant === false`
/// 是排障时最有价值的信号：说明该点被别的元素盖住了，`Input.dispatchMouseEvent`
/// 会打到覆盖物上——这类「点了没反应」靠 `element.click()` 是查不出来的。
pub fn resolve_pointer_target(selector: Option<&str>, reference: Option<&str>) -> String {
    as_sync_body(&render(
        r#"
  const SELECTOR = {SELECTOR};
  const REF = {REF};
  const refKey = (value) => (value === null ? null : (String(value).charAt(0) === 'e' ? String(value) : 'e' + String(value)));
  const el = REF === null
    ? (SELECTOR === null ? null : document.querySelector(SELECTOR))
    : ((window.__PYLON_MCP_REFS__ && window.__PYLON_MCP_REFS__.refs[refKey(REF)]) || null);
  if (!el) {
    return {
      found: false,
      selector: SELECTOR,
      ref: REF,
      reason: REF === null
        ? 'selector 未命中任何元素'
        : 'ref 未命中：它可能来自更早的一次快照，或页面已重载——请重新调用 webview_snapshot',
    };
  }
  if (!el.isConnected) {
    return {
      found: false,
      selector: SELECTOR,
      ref: REF,
      reason: 'ref 指向的元素已不在文档中（多半被重新渲染）——请重新调用 webview_snapshot',
    };
  }

  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });

  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const hit = document.elementFromPoint(x, y);

  return {
    found: true,
    selector: SELECTOR,
    ref: REF,
    resolvedVia: REF === null ? 'selector' : 'ref',
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
        &[
            ("{SELECTOR}", js_optional_str(selector)),
            ("{REF}", js_optional_str(reference)),
        ],
    ))
}

/// `mode=dom` 的点击：直接调 `element.click()`，绕过命中测试。
pub fn dom_click(selector: Option<&str>, reference: Option<&str>) -> String {
    as_sync_body(&render(
        r#"
  const SELECTOR = {SELECTOR};
  const REF = {REF};
  const refKey = (value) => (value === null ? null : (String(value).charAt(0) === 'e' ? String(value) : 'e' + String(value)));
  const el = REF !== null
    ? ((window.__PYLON_MCP_REFS__ && window.__PYLON_MCP_REFS__.refs[refKey(REF)]) || null)
    : (SELECTOR === null ? null : document.querySelector(SELECTOR));
  if (!el) {
    return {
      clicked: false,
      selector: SELECTOR,
      ref: REF,
      reason: REF === null ? 'selector 未命中任何元素' : 'ref 未命中：请重新调用 webview_snapshot',
    };
  }
  el.click();
  return {
    clicked: true,
    selector: SELECTOR,
    ref: REF,
    tag: el.tagName.toLowerCase(),
    disabled: !!el.disabled,
  };
"#,
        &[
            ("{SELECTOR}", js_optional_str(selector)),
            ("{REF}", js_optional_str(reference)),
        ],
    ))
}

/// 聚焦输入目标，可选先清空。
///
/// 「清空」走 DOM 赋值 + 派发 `input` 事件，而不是全选后覆盖：
/// 受控组件（Solid/React 的受控输入）只有收到 `input` 才会同步内部状态，
/// 只改 `value` 会让 UI 与状态脱节，后续输入的行文也会错位。
pub fn focus_for_typing(selector: Option<&str>, reference: Option<&str>, clear: bool) -> String {
    as_sync_body(&render(
        r#"
  const SELECTOR = {SELECTOR};
  const REF = {REF};
  const CLEAR = {CLEAR};

  const refKey = (value) => (value === null ? null : (String(value).charAt(0) === 'e' ? String(value) : 'e' + String(value)));
  const el = REF !== null
    ? ((window.__PYLON_MCP_REFS__ && window.__PYLON_MCP_REFS__.refs[refKey(REF)]) || null)
    : (SELECTOR === null ? document.activeElement : document.querySelector(SELECTOR));
  if (!el) {
    return {
      found: false,
      selector: SELECTOR,
      ref: REF,
      reason: REF !== null
        ? 'ref 未命中：它可能来自更早的一次快照，或页面已重载——请重新调用 webview_snapshot'
        : (SELECTOR === null ? '当前没有聚焦元素' : 'selector 未命中'),
    };
  }

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
    ref: REF,
    resolvedVia: REF === null ? (SELECTOR === null ? 'activeElement' : 'selector') : 'ref',
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
            ("{REF}", js_optional_str(reference)),
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
    as_async_body(&events_subscribe_body(names, target, max_buffer, reset))
}

/// 供 `Page.addScriptToEvaluateOnNewDocument` 注入的版本：每次新文档都重跑一遍，
/// 于是 reload 之后订阅自动恢复，不必等 agent 再喊一次。
///
/// 与直接注入的那份有两点不同：
///
/// 1. **先等 `__TAURI_INTERNALS__` 出现**。新文档注入脚本与 Tauri 自己的
///    init 脚本谁先执行没有明文的保证；抢跑的话 `invoke` 还不存在，订阅会
///    静默失败（这正是「reload 后事件再也不来」最难查的形态）。
/// 2. **不 reset**：新文档本来就是干净的缓冲。
pub fn events_subscribe_on_new_document(
    names: &[String],
    target: &Value,
    max_buffer: usize,
) -> String {
    as_sync_body(&render(
        r#"
  const start = async () => {
{BODY}
  };
  let attempts = 0;
  const wait = () => {
    const internals = window.__TAURI_INTERNALS__;
    if (internals && typeof internals.invoke === 'function') { start().catch(() => {}); return; }
    // 约 5 秒内每 50ms 看一眼；再等不到就放弃（页面多半不是 Tauri webview）。
    if (++attempts > 100) return;
    setTimeout(wait, 50);
  };
  wait();
"#,
        &[(
            "{BODY}",
            events_subscribe_body(names, target, max_buffer, false),
        )],
    ))
}

/// 订阅脚本的**函数体**（可直接作为 async IIFE 内容）。两个注入点共用这一份，
/// 避免「直接注入」与「新文档注入」两套逻辑漂移。
fn events_subscribe_body(
    names: &[String],
    target: &Value,
    max_buffer: usize,
    reset: bool,
) -> String {
    let names: Vec<String> = names.iter().map(|n| js_str(n)).collect();
    render(
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
    )
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

// ─────────────────────── 网页界面增强：等待 / 滚动 / 命中 / 选择 ───────────────────────

/// `webview_wait` 探针：等待 selector 命中的元素出现（`hidden=true` 时等它消失或不可见）。
///
/// 由 Rust 侧按 `poll_ms` 轮询，一次求值只回答「现在满足了吗」。
/// 可见性优先 `checkVisibility`，旧引擎退化为盒尺寸非零。
pub fn wait_selector(selector: &str, hidden: bool) -> String {
    as_sync_body(&render(
        r#"
  const SELECTOR = {SELECTOR};
  const HIDDEN = {HIDDEN};

  const visible = (el) => {
    if (!el) return false;
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const el = document.querySelector(SELECTOR);
  if (HIDDEN) return { satisfied: !visible(el), present: !!el, visible: visible(el) };
  return { satisfied: !!el, present: !!el, visible: visible(el) };
"#,
        &[
            ("{SELECTOR}", js_str(selector)),
            ("{HIDDEN}", hidden.to_string()),
        ],
    ))
}

/// `webview_wait` 探针：任意 JS 表达式按 `Boolean` 截断后为真。
/// `return Boolean(` 与 `)` 之间强制换行——表达式末尾的 `//` 行注释
/// 不能把闭合一起注释掉（与 [`as_async_expression`] 同一条纪律）。
pub fn wait_condition(expression: &str) -> String {
    as_sync_body(&render(
        r#"
  return { satisfied: Boolean(
{EXPR}
  ) };
"#,
        &[("{EXPR}", expression.to_string())],
    ))
}

/// `webview_wait` 探针：等待 `location.href` 包含给定子串（大小写不敏感），
/// 用于等待 SPA 路由切换。
pub fn wait_href(fragment: &str) -> String {
    as_sync_body(&render(
        r#"
  const FRAGMENT = {FRAGMENT};
  return { satisfied: location.href.toLowerCase().includes(FRAGMENT.toLowerCase()), href: location.href };
"#,
        &[("{FRAGMENT}", js_str(fragment))],
    ))
}

/// `webview_wait` 探针：等待 `document.readyState` 到 `complete`。
pub fn wait_ready() -> String {
    as_sync_body(
        "return { satisfied: document.readyState === 'complete', readyState: document.readyState };",
    )
}

/// `webview_click` 坐标模式的命中测试：这个坐标上实际是什么元素。
/// 没有目标元素可比对，但「点之前先知道打到谁」同样是「点了没反应」的第一手证据。
pub fn point_hit(x: f64, y: f64) -> String {
    as_sync_body(&render(
        r#"
  const X = {X};
  const Y = {Y};
  const hit = document.elementFromPoint(X, Y);
  return {
    hitTag: hit ? hit.tagName.toLowerCase() : null,
    hitPath: hit ? (hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '')) : null,
    pointerEvents: hit ? getComputedStyle(hit).pointerEvents : null,
  };
"#,
        &[("{X}", x.to_string()), ("{Y}", y.to_string())],
    ))
}

/// 滚动窗口或指定容器。定位方式按优先级：`to` → 相对位移 → 绝对坐标 →
/// selector 居中（无任何参数时回顶部）。返回滚动后的三层位置供回读。
pub fn scroll_page(
    selector: Option<&str>,
    to: Option<&str>,
    x: Option<f64>,
    y: Option<f64>,
    dx: Option<f64>,
    dy: Option<f64>,
) -> String {
    let number = |value: Option<f64>| {
        value
            .map(|v| v.to_string())
            .unwrap_or_else(|| "null".to_string())
    };
    as_sync_body(&render(
        r#"
  const SELECTOR = {SELECTOR};
  const TO = {TO};
  const X = {X};
  const Y = {Y};
  const DX = {DX};
  const DY = {DY};

  const el = SELECTOR === null ? null : document.querySelector(SELECTOR);
  if (SELECTOR !== null && !el) return { found: false, selector: SELECTOR };

  if (el) {
    if (TO === 'top') el.scrollTop = 0;
    else if (TO === 'bottom') el.scrollTop = el.scrollHeight;
    else if (DX !== null || DY !== null) { el.scrollLeft += DX || 0; el.scrollTop += DY || 0; }
    else if (X !== null || Y !== null) { el.scrollLeft = X || 0; el.scrollTop = Y || 0; }
    else el.scrollIntoView({ block: 'center', inline: 'center' });
  } else if (TO === 'top') {
    window.scrollTo(0, 0);
  } else if (TO === 'bottom') {
    window.scrollTo(0, document.documentElement.scrollHeight);
  } else if (DX !== null || DY !== null) {
    window.scrollBy(DX || 0, DY || 0);
  } else {
    window.scrollTo(X || 0, Y || 0);
  }

  return {
    found: true,
    selector: SELECTOR,
    window: { scrollX: window.scrollX, scrollY: window.scrollY },
    document: {
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
      clientHeight: window.innerHeight,
    },
    element: el ? {
      scrollTop: el.scrollTop,
      scrollLeft: el.scrollLeft,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    } : null,
  };
"#,
        &[
            ("{SELECTOR}", js_optional_str(selector)),
            (
                "{TO}",
                match to {
                    Some(value) => js_str(value),
                    None => "null".to_string(),
                },
            ),
            ("{X}", number(x)),
            ("{Y}", number(y)),
            ("{DX}", number(dx)),
            ("{DY}", number(dy)),
        ],
    ))
}

/// `webview_select`：按 value / label / 下标选中 `<select>` 的选项。
///
/// 选中后派发 `input` + `change`——受控组件只有收到事件才会同步内部状态，
/// 只改 `selected` 会让 UI 与状态脱节。匹配不到时把现有选项带回去，
/// 让调用方不必再发一次 `webview_query` 猜选项名。
pub fn select_options(
    selector: Option<&str>,
    reference: Option<&str>,
    mode: &str,
    wanted: &Value,
) -> String {
    as_sync_body(&render(
        r#"
  const SELECTOR = {SELECTOR};
  const REF = {REF};
  const MODE = {MODE};
  const WANTED = {WANTED};

  const refKey = (value) => (value === null ? null : (String(value).charAt(0) === 'e' ? String(value) : 'e' + String(value)));
  const el = REF !== null
    ? ((window.__PYLON_MCP_REFS__ && window.__PYLON_MCP_REFS__.refs[refKey(REF)]) || null)
    : (SELECTOR === null ? null : document.querySelector(SELECTOR));
  if (!el) {
    return {
      found: false,
      selector: SELECTOR,
      ref: REF,
      reason: REF === null ? 'selector 未命中任何元素' : 'ref 未命中：请重新调用 webview_snapshot',
    };
  }
  if (el.tagName !== 'SELECT') {
    return { found: true, selector: SELECTOR, reason: 'not-a-select', tag: el.tagName.toLowerCase() };
  }

  const options = Array.from(el.options);
  const matches = (option) => {
    if (MODE === 'value') return WANTED.includes(option.value);
    if (MODE === 'label') return WANTED.includes(option.label.trim());
    return WANTED.includes(option.index);
  };
  const matched = options.filter(matches).map((option) => ({
    value: option.value, label: option.label, index: option.index,
  }));
  if (matched.length === 0) {
    return {
      found: true,
      reason: 'no-matching-option',
      wanted: WANTED,
      available: options.slice(0, 50).map((option) => ({ value: option.value, label: option.label })),
    };
  }

  if (!el.multiple) el.selectedIndex = -1;
  for (const option of options) {
    if (matches(option)) {
      option.selected = true;
      if (!el.multiple) break;
    }
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));

  return {
    found: true,
    multiple: el.multiple,
    matched,
    selectedValues: Array.from(el.selectedOptions).map((option) => option.value),
    changed: true,
  };
"#,
        &[
            ("{SELECTOR}", js_optional_str(selector)),
            ("{REF}", js_optional_str(reference)),
            ("{MODE}", js_str(mode)),
            ("{WANTED}", js_value(wanted)),
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
    fn aria_snapshot_embeds_scope_limits_and_stores_refs() {
        let script = aria_snapshot(Some("#chat"), 120, false);
        assert!(script.contains(r##"const SCOPE = "#chat";"##), "{script}");
        assert!(script.contains("const MAX_NODES = 120;"));
        assert!(script.contains("const INCLUDE_VALUES = false;"));
        // ref 必须写进页内映射，否则后续 click/type 拿不到元素。
        assert!(script.contains("window.__PYLON_MCP_REFS__ = { at: Date.now(), refs: refs };"));
        assert!(script.contains("' [ref=' + ref + ']'"));
        assert!(
            script.contains("snapshot: lines.join("),
            "返回体必须给文本树"
        );

        let whole_page = aria_snapshot(None, 300, true);
        assert!(whole_page.contains("const SCOPE = null;"));
        assert!(whole_page.contains("const INCLUDE_VALUES = true;"));
        // 不可见与 aria-hidden 的子树要跳过，否则树里会混进一堆隐藏节点。
        assert!(whole_page.contains("aria-hidden"));
        assert!(whole_page.contains("checkVisibility"));
    }

    #[test]
    fn ref_lookup_uses_the_snapshot_map_and_reports_stale_refs() {
        let by_ref = resolve_pointer_target(None, Some("e12"));
        assert!(by_ref.contains(r#"const REF = "e12";"#), "{by_ref}");
        assert!(by_ref.contains("const SELECTOR = null;"));
        assert!(by_ref.contains("refKey"));
        // 元素被重新渲染后 ref 会指向游离节点：必须明确报错而不是点到别处。
        assert!(by_ref.contains("isConnected"), "{by_ref}");
        assert!(by_ref.contains("请重新调用 webview_snapshot"));

        let by_selector = resolve_pointer_target(Some("#a"), None);
        assert!(by_selector.contains("const REF = null;"));
        assert!(by_selector.contains(r##"const SELECTOR = "#a";"##));
    }

    #[test]
    fn dom_click_and_select_also_accept_refs() {
        let dom = dom_click(None, Some("e3"));
        assert!(dom.contains(r#"const REF = "e3";"#), "{dom}");
        assert!(dom.contains("el.click()"));

        let select = select_options(None, Some("e4"), "value", &json!(["a"]));
        assert!(select.contains("const SELECTOR = null;"), "{select}");
        assert!(select.contains(r#"const REF = "e4";"#));
        assert!(select.contains("请重新调用 webview_snapshot"));
    }

    #[test]
    fn click_target_selector_is_escaped_not_interpolated() {
        // 选择器里带引号必须被转义，不能逃逸成 JS 代码。
        let script = resolve_pointer_target(Some("a[title=\"x\"]"), None);
        assert!(
            script.contains(r#"const SELECTOR = "a[title=\"x\"]";"#),
            "{script}"
        );
    }

    #[test]
    fn wait_selector_probe_encodes_hidden_flag() {
        let appear = wait_selector("#toast", false);
        assert!(
            appear.contains(r##"const SELECTOR = "#toast";"##),
            "{appear}"
        );
        assert!(appear.contains("const HIDDEN = false;"));
        let disappear = wait_selector("#toast", true);
        assert!(disappear.contains("const HIDDEN = true;"));
    }

    #[test]
    fn wait_condition_keeps_closing_paren_after_a_trailing_line_comment() {
        // 与 as_async_expression 同一条纪律：注释不能吃掉 Boolean( 的闭合。
        let script = wait_condition("x === 1 // only now");
        let close = script.rfind(")").unwrap();
        let comment = script.find("// only now").unwrap();
        assert!(script[comment..close].contains('\n'), "{script}");
    }

    #[test]
    fn wait_href_and_ready_probes_embed_their_inputs() {
        let href = wait_href("/sessions/42");
        assert!(
            href.contains(r#"const FRAGMENT = "/sessions/42";"#),
            "{href}"
        );
        assert!(href.contains("toLowerCase()"));
        let ready = wait_ready();
        assert!(
            ready.contains("document.readyState === 'complete'"),
            "{ready}"
        );
    }

    #[test]
    fn point_hit_reports_what_is_at_the_coordinates() {
        let script = point_hit(12.5, 40.0);
        assert!(script.contains("const X = 12.5;"), "{script}");
        assert!(script.contains("const Y = 40;"), "{script}");
        assert!(script.contains("elementFromPoint"));
    }

    #[test]
    fn scroll_page_embeds_every_axis_and_optional_selector() {
        let window_scroll = scroll_page(None, Some("bottom"), None, None, Some(-120.0), None);
        assert!(
            window_scroll.contains("const TO = \"bottom\";"),
            "{window_scroll}"
        );
        assert!(window_scroll.contains("const DX = -120;"));
        assert!(window_scroll.contains("const DY = null;"));
        assert!(window_scroll.contains("const SELECTOR = null;"));

        let element_scroll = scroll_page(Some(".list"), None, None, Some(300.0), None, None);
        assert!(
            element_scroll.contains(r#"const SELECTOR = ".list";"#),
            "{element_scroll}"
        );
        assert!(element_scroll.contains("const Y = 300;"));
    }

    #[test]
    fn select_options_embeds_mode_and_wanted_values() {
        let by_value = select_options(Some("#lang"), None, "value", &json!(["zh-Hans", "en"]));
        assert!(
            by_value.contains(r##"const SELECTOR = "#lang";"##),
            "{by_value}"
        );
        assert!(by_value.contains(r#"const MODE = "value";"#));
        assert!(by_value.contains(r#"const WANTED = ["zh-Hans","en"];"#));
        assert!(by_value.contains("dispatchEvent(new Event('change'"));

        let by_index = select_options(Some("#lang"), None, "index", &json!([2]));
        assert!(by_index.contains(r#"const MODE = "index";"#), "{by_index}");
        assert!(by_index.contains("const WANTED = [2];"));
    }

    #[test]
    fn typing_without_selector_falls_back_to_active_element() {
        let script = focus_for_typing(None, None, true);
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
    fn the_new_document_variant_waits_for_tauri_then_reuses_the_same_body() {
        let script = events_subscribe_on_new_document(
            &["session://update".to_string()],
            &json!({ "kind": "Any" }),
            500,
        );
        // 必须等 __TAURI_INTERNALS__：新文档注入与 Tauri init 的先后没有保证。
        assert!(
            script.contains("typeof internals.invoke === 'function'"),
            "{script}"
        );
        assert!(script.contains("setTimeout(wait, 50)"), "{script}");
        // 订阅逻辑与直接注入那份是同一份体（避免两套逻辑漂移）。
        assert!(script.contains("plugin:event|listen"), "{script}");
        assert!(
            script.contains(r#"const NAMES = ["session://update"];"#),
            "{script}"
        );
        // 新文档本来就是干净的缓冲，不该 reset。
        assert!(script.contains("const RESET = false;"), "{script}");
        assert!(!script.contains("const RESET = true;"), "{script}");
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
            resolve_pointer_target(Some("#a"), None),
            resolve_pointer_target(None, Some("e3")),
            dom_click(Some("#a"), None),
            dom_click(None, Some("e3")),
            aria_snapshot(Some("#a"), 50, true),
            aria_snapshot(None, 50, false),
            focus_for_typing(Some("#a"), None, false),
            focus_for_typing(None, Some("e7"), true),
            window_state("main"),
            tauri_invoke("cmd", &json!({})),
            events_subscribe(&["e".to_string()], &json!({ "kind": "Any" }), 10, false),
            events_subscribe_on_new_document(&["e".to_string()], &json!({ "kind": "Any" }), 10),
            events_drain(None, 10, 10),
            events_drain(Some(1), 10, 10),
            wait_selector("#a", false),
            wait_selector("#a", true),
            wait_condition("x === 1"),
            wait_condition("location.hash === '#/done'"),
            wait_href("/sessions/42"),
            wait_ready(),
            point_hit(1.5, 2.0),
            scroll_page(None, None, None, None, None, None),
            scroll_page(
                Some(".list"),
                Some("bottom"),
                None,
                None,
                Some(-1.0),
                Some(2.5),
            ),
            select_options(Some("#lang"), None, "value", &json!(["zh-Hans"])),
            select_options(None, Some("e4"), "index", &json!([0, 2])),
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
