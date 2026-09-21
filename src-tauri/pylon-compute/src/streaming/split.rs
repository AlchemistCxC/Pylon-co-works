//! 流式 markdown 的 stable/unstable 边界切分（对应 TS 基线
//! `src/renderers/solid-workbench/chat/streamingMarkdownSplit.ts`，#220 WP3）。
//!
//! 语义契约（不变量，与 TS 逐字对齐）：
//! - 只提交**已确认的顶层块边界**——块外的空行；容器内空行不构成边界；
//! - 容器行（引用/列表）出现即终止扫描：与其后缀绑在一起，不从缩进猜 CommonMark
//!   边界（嵌套围栏/惰性续行需要它）；
//! - 代码围栏未闭合时整段计入 `unstable`（不跨边界劈开围栏），保证高亮不被切分破坏。
//!
//! # 分层
//!
//! 内层是普通 Rust 函数（`&str` 进、`String` 出，可在宿主跑原生单测与 property
//! test）；`#[wasm_bindgen]` 薄壳只做值/错误转换——`JsError::new` 在非 wasm 目标会
//! panic，可失败逻辑不得写在壳里（见 `canonical.rs` 的分层说明）。
//!
//! # 与 JS 的字符语义对齐
//!
//! - TS 在 UTF-16 上工作，Rust 在 UTF-8 上工作：所有**导出的偏移量**（如
//!   `findLastStableBlockBoundary`）按 UTF-16 单位计数；字符串切片只在字节层面
//!   进行，且只落在行边界/char 边界这类天然安全的位置上；
//! - 正则手写展开（不引 regex 依赖，且语义必须与 JS 正则**逐步**一致，不是
//!   "大致相当"）：其中 `trim()` 与 `\s` 的字符集是 JS 规范白名单（含 NBSP、
//!   ZWNBSP、U+2028 等），**不等于** Rust 的 `char::is_whitespace`（例如 U+FEFF
//!   前者裁、后者不裁），故用 [`js_whitespace`] 精确复刻。

use serde::Serialize;
use wasm_bindgen::prelude::*;

// ── 纯内层（宿主可测，零 JS 依赖） ───────────────────────────────────────────

/// JS 规范的空白字符集：`String.prototype.trim` 与正则 `\s` 共用同一份白名单。
/// 与 Rust `char::is_whitespace` 的差异点：U+FEFF（ZWNBSP）在此裁/匹配、在
/// `is_whitespace` 不算空白——这正是不能直接用后者的理由。
fn js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{000B}' | '\u{000C}' | '\r' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// JS `line.endsWith('\r') ? line.slice(0, -1) : line`。
fn strip_trailing_cr(line: &str) -> &str {
    line.strip_suffix('\r').unwrap_or(line)
}

/// 最多吃掉行首 3 个空格（正则 `^ {0,3}`；第 4 个空格起语义不同，不可贪多）。
fn skip_up_to_three_spaces(line: &str) -> &str {
    let bytes = line.as_bytes();
    let mut offset = 0usize;
    while offset < 3 && offset < bytes.len() && bytes[offset] == b' ' {
        offset += 1;
    }
    &line[offset..]
}

/// 保守的容器行判定：`/^ {0,3}(?:>|(?:[-+*]|\d{1,9}[.)])(?:[\t ]|$))/`。
/// 误判为容器只是多保留上下文（安全侧），漏判才会破坏结构。
fn is_container_line(line: &str) -> bool {
    let rest = skip_up_to_three_spaces(line);
    let bytes = rest.as_bytes();
    match bytes.first() {
        Some(b'>') => true,
        Some(b'-' | b'+' | b'*') => matches!(bytes.get(1), None | Some(b'\t' | b' ')),
        Some(b'0'..=b'9') => {
            // `\d{1,9}[.)](?:[\t ]|$)`：正则回溯的可行解只有「整段数字运行」一种——
            // 更短的 k 落在数字上必不匹配 [.)]；超过 9 位则 k≤9 处全是数字。
            let mut run = 0usize;
            while run < bytes.len() && bytes[run].is_ascii_digit() {
                run += 1;
            }
            (1..=9).contains(&run)
                && matches!(bytes.get(run), Some(b'.' | b')'))
                && matches!(bytes.get(run + 1), None | Some(b'\t' | b' '))
        }
        _ => false,
    }
}

/// `/^[\t ]*$/`：只认字面空格与制表符（比 `\s` 窄，别复用 [`js_whitespace`]）。
fn is_blank_line(line: &str) -> bool {
    line.bytes().all(|byte| byte == b'\t' || byte == b' ')
}

/// 围栏闭合行：`/^ {0,3}(`+|~+)[\t ]*$/`，返回 (marker 字符, marker 长度)。
fn fence_close_marker(line: &str) -> Option<(char, usize)> {
    let rest = skip_up_to_three_spaces(line);
    let marker_char = rest.chars().next()?;
    if marker_char != '`' && marker_char != '~' {
        return None;
    }
    let mut tail = rest;
    let mut marker_length = 0usize;
    while let Some(stripped) = tail.strip_prefix(marker_char) {
        marker_length += 1;
        tail = stripped;
    }
    if tail.chars().all(|c| c == '\t' || c == ' ') {
        Some((marker_char, marker_length))
    } else {
        None
    }
}

/// 围栏开启行：`/^ {0,3}(`{3,}|~{3,})(.*)$/`，返回 (marker 字符, marker 长度, info 串)。
fn fence_open_marker(line: &str) -> Option<(char, usize, &str)> {
    let rest = skip_up_to_three_spaces(line);
    let marker_char = rest.chars().next()?;
    if marker_char != '`' && marker_char != '~' {
        return None;
    }
    let mut tail = rest;
    let mut marker_length = 0usize;
    while let Some(stripped) = tail.strip_prefix(marker_char) {
        marker_length += 1;
        tail = stripped;
    }
    if marker_length < 3 {
        return None;
    }
    Some((marker_char, marker_length, tail))
}

/// info 串取语言 token：`info.trim().split(/\s+/, 1)[0] || undefined`。
/// 空串/纯空白 ⇒ `None`（TS 的 `''` 为假值）。
fn first_info_token(info: &str) -> Option<String> {
    let trimmed = info.trim_matches(js_whitespace);
    let token: String = trimmed.chars().take_while(|c| !js_whitespace(*c)).collect();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

/// [`split_streaming_markdown_blocks`] 的返回：stable 顶块逐段保留（已解析结果
/// 永不增长、可缓存复用），unstable 是仍在增长的尾块。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SplitBlocks {
    pub stable_blocks: Vec<String>,
    pub unstable: String,
}

/// 扫描 stable 顶块边界，返回**已提交块的字节结束偏移**（升序；首块从 0 起）。
///
/// 三个出口（`split_streaming_markdown_blocks` 的整组字符串、
/// `split_streaming_markdown_block_ends` 的 UTF-16 偏移数组、
/// `find_last_stable_block_boundary` 的末偏移）共用这一趟扫描——
/// 切分语义只在这一处。
fn stable_block_byte_ends(text: &str) -> Vec<usize> {
    let mut ends: Vec<usize> = Vec::new();
    let mut block_start = 0usize;
    let mut in_fence = false;
    // fence 字符/长度只在 in_fence 时有意义；占位值与 TS 初始值同形
    let mut fence_char = '`';
    let mut fence_length = 0usize;
    let mut position = 0usize;

    while position < text.len() {
        let newline = text[position..].find('\n').map(|offset| position + offset);
        let next_position = newline.map_or(text.len(), |index| index + 1);
        let line = strip_trailing_cr(&text[position..newline.unwrap_or(text.len())]);

        if in_fence {
            // 同款 marker 且不短于开启 marker 才算闭合；更短或带尾随文本都不行
            if let Some((marker_char, marker_length)) = fence_close_marker(line) {
                if marker_char == fence_char && marker_length >= fence_length {
                    in_fence = false;
                    fence_char = '`';
                    fence_length = 0;
                }
            }
        } else {
            // 容器行 break（不是 continue）：空行不关闭列表/引用，容器与其后缀
            // 绑在一起直到完成，不从缩进猜边界。
            if is_container_line(line) {
                break;
            }
            match fence_open_marker(line) {
                // 反引号围栏的 info 串含反引号时不开围栏（CommonMark）；波浪号围栏无此限制
                Some((marker_char, marker_length, info))
                    if marker_char == '~' || !info.contains('`') =>
                {
                    in_fence = true;
                    fence_char = marker_char;
                    fence_length = marker_length;
                }
                // 与 TS 相同的 else-if 链：匹配到开启行但条件不成立时，该行必含
                // 反引号、空白判定天然为假——结构上仍要走空行分支
                _ => {
                    if is_blank_line(line) && newline.is_some() {
                        // 空白分隔符保留在源前缀里，但不产生空块；纯空白候选不推进
                        // block_start（它粘进下一个已提交块，与 TS 行为逐字一致）
                        if !text[block_start..next_position]
                            .trim_matches(js_whitespace)
                            .is_empty()
                        {
                            ends.push(next_position);
                            block_start = next_position;
                        }
                    }
                }
            }
        }
        position = next_position;
    }

    ends
}

/// 把流式文本切成 stable 顶块序列 + unstable 尾块（TS `splitStreamingMarkdownBlocks`）。
pub fn split_streaming_markdown_blocks(text: &str) -> SplitBlocks {
    let ends = stable_block_byte_ends(text);
    let mut stable_blocks = Vec::with_capacity(ends.len());
    let mut start = 0usize;
    for end in &ends {
        stable_blocks.push(text[start..*end].to_string());
        start = *end;
    }
    SplitBlocks {
        stable_blocks,
        unstable: text[start..].to_string(),
    }
}

/// TS `splitStreamingMarkdown`：stable 是已完成块（拼接），unstable 是尾块。
pub fn split_streaming_markdown(text: &str) -> (String, String) {
    let split = split_streaming_markdown_blocks(text);
    (split.stable_blocks.concat(), split.unstable)
}

/// TS `findLastStableBlockBoundary`：最后一个已证安全的块边界的**UTF-16 偏移**。
/// TS 按 `text.length - unstable.length` 计算，这里换算成同一量纲。
pub fn find_last_stable_block_boundary(text: &str) -> usize {
    let stable_bytes = stable_block_byte_ends(text).last().copied().unwrap_or(0);
    text[..stable_bytes].encode_utf16().count()
}

/// stable 顶块的 **UTF-16 结束偏移**升序数组（TS 侧没有对位出口，#220 边界收口新增）。
///
/// 热路径（`MarkdownContent` 每次发布重推导行集）只用偏移，不用块内容：块内容
/// JS 侧从自己持有的文本 `slice` 即可，整组块字符串每拍过界是 O(全文) 的
/// Rust 分配 + serde 编组。与 `split_streaming_markdown_blocks` 的关系（由
/// `split_block_ends_match_the_blocks_split` 钉死）：
/// `ends[i]` 处切片 == 第 i 个 stable 块；`ends.last() ?? 0` == stable 前缀的
/// UTF-16 长度 == `findLastStableBlockBoundary`。
pub fn split_streaming_markdown_block_ends(text: &str) -> Vec<u32> {
    let ends = stable_block_byte_ends(text);
    let mut utf16_ends = Vec::with_capacity(ends.len());
    let mut units = 0u32;
    let mut cursor = 0usize;
    for end in &ends {
        // 增量累计：每个字节只被编码一次，不做逐块的整前缀重数
        units += text[cursor..*end].encode_utf16().count() as u32;
        utf16_ends.push(units);
        cursor = *end;
    }
    utf16_ends
}

/// TS `OpenCodeFenceTail`：文末最后一个仍未闭合的围栏代码块。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenCodeFenceTail {
    pub prefix: String,
    pub language: Option<String>,
    pub code: String,
}

/// 提取文末仍开启的围栏代码块（TS `splitOpenCodeFenceTail`），在 markdown 解析
/// 之前把代码按纯文本渲染，省掉每次增量的一整个解析器 + 高亮器 pass。
/// 返回 `None`：不存在未闭合围栏，或扫到了容器行（保守放弃）。
pub fn split_open_code_fence_tail(text: &str) -> Option<OpenCodeFenceTail> {
    struct OpenFence {
        start: usize,
        content_start: usize,
        marker_char: char,
        marker_length: usize,
        language: Option<String>,
    }
    let mut open: Option<OpenFence> = None;
    let mut position = 0usize;

    while position < text.len() {
        let newline = text[position..].find('\n').map(|offset| position + offset);
        let line = strip_trailing_cr(&text[position..newline.unwrap_or(text.len())]);

        match open.as_mut() {
            Some(state) => {
                if let Some((marker_char, marker_length)) = fence_close_marker(line) {
                    if marker_char == state.marker_char && marker_length >= state.marker_length {
                        open = None;
                    }
                }
            }
            None => {
                if is_container_line(line) {
                    return None;
                }
                if let Some((marker_char, marker_length, info)) = fence_open_marker(line) {
                    if marker_char == '~' || !info.contains('`') {
                        open = Some(OpenFence {
                            start: position,
                            content_start: newline.map_or(text.len(), |index| index + 1),
                            marker_char,
                            marker_length,
                            language: first_info_token(info),
                        });
                    }
                }
            }
        }

        match newline {
            Some(index) => position = index + 1,
            None => break,
        }
    }

    let state = open?;
    let body = &text[state.content_start..];
    Some(OpenCodeFenceTail {
        prefix: text[..state.start].to_string(),
        language: state.language,
        // TS `.replace(/\r\n/g, '\n')`：把围栏体内的 CRLF 归一成 LF。
        // `str::replace` 无条件分配，无 CRLF 的常态（绝大多数代码体）直接拷走。
        code: if body.contains("\r\n") {
            body.replace("\r\n", "\n")
        } else {
            body.to_string()
        },
    })
}

// ── wasm 薄壳（只做值/错误转换） ─────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SplitBlocksDto {
    stable_blocks: Vec<String>,
    unstable: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SplitDto {
    stable: String,
    unstable: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenCodeFenceTailDto {
    prefix: String,
    // None 序列化为 undefined（serde-wasm-bindgen 默认），与 TS 的「字段缺省」同形
    language: Option<String>,
    code: String,
}

#[wasm_bindgen(js_name = splitStreamingMarkdownBlocks)]
pub fn split_streaming_markdown_blocks_js(text: &str) -> Result<JsValue, JsError> {
    let split = split_streaming_markdown_blocks(text);
    serde_wasm_bindgen::to_value(&SplitBlocksDto {
        stable_blocks: split.stable_blocks,
        unstable: split.unstable,
    })
    .map_err(|error| JsError::new(&format!("切分结果序列化失败: {error}")))
}

/// stable 顶块的 UTF-16 结束偏移数组（热路径出口：JS 从自己持有的文本切片）。
#[wasm_bindgen(js_name = splitStreamingMarkdownBlockEnds)]
pub fn split_streaming_markdown_block_ends_js(text: &str) -> Vec<u32> {
    split_streaming_markdown_block_ends(text)
}

#[wasm_bindgen(js_name = splitStreamingMarkdown)]
pub fn split_streaming_markdown_js(text: &str) -> Result<JsValue, JsError> {
    let (stable, unstable) = split_streaming_markdown(text);
    serde_wasm_bindgen::to_value(&SplitDto { stable, unstable })
        .map_err(|error| JsError::new(&format!("切分结果序列化失败: {error}")))
}

#[wasm_bindgen(js_name = findLastStableBlockBoundary)]
pub fn find_last_stable_block_boundary_js(text: &str) -> f64 {
    find_last_stable_block_boundary(text) as f64
}

#[wasm_bindgen(js_name = splitOpenCodeFenceTail)]
pub fn split_open_code_fence_tail_js(text: &str) -> Result<JsValue, JsError> {
    match split_open_code_fence_tail(text) {
        None => Ok(JsValue::NULL),
        Some(tail) => serde_wasm_bindgen::to_value(&OpenCodeFenceTailDto {
            prefix: tail.prefix,
            language: tail.language,
            code: tail.code,
        })
        .map_err(|error| JsError::new(&format!("尾块序列化失败: {error}"))),
    }
}

// ── 原生单测（契约夹具来自 TS `chat/__tests__/streamingMarkdownSplit.test.ts`） ──

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_paragraph_has_empty_stable() {
        let split = split_streaming_markdown("正在回复的一段话");
        assert_eq!(split, (String::new(), "正在回复的一段话".to_string()));
    }

    #[test]
    fn complete_block_boundary_is_the_last_blank_line() {
        let split = split_streaming_markdown("第一行\n\n第二行片段");
        assert_eq!(split, ("第一行\n\n".to_string(), "第二行片段".to_string()));
        // UTF-16 偏移：'第一行'(3) + '\n\n'(2)
        assert_eq!(find_last_stable_block_boundary("第一行\n\n第二行片段"), 5);
    }

    #[test]
    fn stable_prefix_only_moves_forward() {
        let s1 = split_streaming_markdown("A\n\nB");
        let s2 = split_streaming_markdown("A\n\nBBB");
        assert_eq!(s1, ("A\n\n".to_string(), "B".to_string()));
        assert_eq!(s2, ("A\n\n".to_string(), "BBB".to_string()));
    }

    #[test]
    fn unclosed_fence_stays_whole_in_unstable() {
        let open = split_streaming_markdown("头部\n\n```js\nconst x = 1");
        // 围栏前的完整块（含空白分隔符）仍进 stable——TS 同款行为
        assert!(open.1.contains("```js"));
        assert_eq!(open.0, "头部\n\n");

        let closed = split_streaming_markdown("头部\n\n```js\nconst x = 1\n```\n\n新的片段继续");
        assert!(closed.0.contains("```js"));
        assert_eq!(closed.1, "新的片段继续");
    }

    #[test]
    fn blank_line_after_list_does_not_prove_container_end() {
        let text = "- 项1\n- 项2\n\n新段落开始";
        let split = split_streaming_markdown(text);
        assert!(split.0.is_empty());
        assert_eq!(split.1, text);
    }

    #[test]
    fn container_markers_never_split_at_any_wire_boundary() {
        for marker in ["1.", "10)", "-", "+", "*", ">"] {
            let text = format!("# 前文\n\n{marker} **开始**\n\n    **后续**\n    正文\n\n新段落");
            let mut previous_stable = String::new();
            for end in 0..=text.chars().count() {
                let prefix: String = text.chars().take(end).collect();
                let split = split_streaming_markdown_blocks(&prefix);
                let stable = split.stable_blocks.concat();
                assert_eq!(
                    format!("{stable}{}", split.unstable),
                    prefix,
                    "marker={marker} end={end}"
                );
                assert!(
                    stable.starts_with(&previous_stable),
                    "marker={marker} end={end}"
                );
                assert_eq!(
                    find_last_stable_block_boundary(&prefix),
                    stable.encode_utf16().count()
                );
                if end >= "# 前文\n\n".chars().count() {
                    assert_eq!(stable, "# 前文\n\n", "marker={marker} end={end}");
                }
                previous_stable = stable;
            }
        }
    }

    #[test]
    fn ordered_list_digit_run_bounds_match_the_regex() {
        // \d{1,9}：9 位数字 + '.' 是容器；10 位不是（正则回溯无出路）
        assert!(is_container_line("123456789. x"));
        assert!(!is_container_line("1234567890. x"));
        assert!(is_container_line("1) x"));
        assert!(!is_container_line("1.x")); // [.)] 后必须跟 [\t ] 或行尾
        assert!(!is_container_line("12a. x"));
        assert!(is_container_line("   > 引用"));
        assert!(!is_container_line("    4 空格缩进"));
    }

    #[test]
    fn container_looking_text_inside_fence_is_ignored() {
        let text = "```md\n1. item\n\n> quote\n```\n\ntail";
        assert_eq!(split_streaming_markdown_blocks(text).unstable, "tail");
        let head = &text[..text.find("\n```\n").expect("close line")];
        assert!(split_open_code_fence_tail(head)
            .expect("open tail")
            .code
            .contains("> quote"));
    }

    #[test]
    fn indented_fence_needs_matching_longer_close() {
        let text = "前文\n\n  ````js\nconst a = 1\n```\n```still-code\n\nconst b = 2";
        let split = split_streaming_markdown_blocks(text);
        assert_eq!(split.stable_blocks.concat(), "前文\n\n");
        assert!(split.unstable.contains("const a = 1"));
        assert!(split.unstable.contains("const b = 2"));
    }

    #[test]
    fn crlf_blank_boundary_keeps_carriage_return_in_stable() {
        let split = split_streaming_markdown("第一段\r\n\r\n第二段");
        assert_eq!(split, ("第一段\r\n\r\n".to_string(), "第二段".to_string()));
    }

    #[test]
    fn open_tail_extracts_language_and_keeps_fake_closes_in_code() {
        let tail =
            split_open_code_fence_tail("前缀\n  ````ts title\nconst a = 1\n```\nconst b = 2")
                .expect("open tail");
        assert_eq!(tail.prefix, "前缀\n");
        assert_eq!(tail.language.as_deref(), Some("ts"));
        assert_eq!(tail.code, "const a = 1\n```\nconst b = 2");
    }

    #[test]
    fn open_tail_rejects_closed_fence_and_backtick_info() {
        assert!(split_open_code_fence_tail("```ts\nconst a = 1\n```").is_none());
        assert!(split_open_code_fence_tail("```bad`info\nconst a = 1").is_none());
    }

    #[test]
    fn open_tail_marker_mismatches_do_not_close_or_open() {
        // 不同款 marker / 带尾随文本的 close / 4 空格缩进的 open 都不参与围栏状态
        assert!(split_open_code_fence_tail("```ts\nconst a = 1\n~~~")
            .expect("still open")
            .code
            .contains("~~~"));
        assert!(
            split_open_code_fence_tail("```ts\nconst a = 1\n``` trailing")
                .expect("still open")
                .code
                .contains("``` trailing")
        );
        assert!(split_open_code_fence_tail("    ```ts\nconst a = 1").is_none());
    }

    #[test]
    fn open_tail_normalizes_crlf_and_accepts_longer_close() {
        let tail =
            split_open_code_fence_tail("前缀\r\n~~~ ts\r\nconst a = 1\r\n").expect("open tail");
        assert_eq!(tail.prefix, "前缀\r\n");
        assert_eq!(tail.language.as_deref(), Some("ts"));
        assert_eq!(tail.code, "const a = 1\n");
        assert!(split_open_code_fence_tail("~~~ts\nconst a = 1\n~~~~").is_none());
    }

    #[test]
    fn empty_text_has_boundary_zero() {
        assert_eq!(find_last_stable_block_boundary(""), 0);
        assert_eq!(split_streaming_markdown(""), (String::new(), String::new()));
    }

    #[test]
    fn whitespace_only_info_string_has_no_language() {
        let tail = split_open_code_fence_tail("```\ncode").expect("open tail");
        assert_eq!(tail.language, None);
        // JS `trim` 与 Rust `trim` 的差异点：U+FEFF 按 JS 语义裁掉
        let feff = split_open_code_fence_tail("```\u{FEFF} ts\ncode").expect("open tail");
        assert_eq!(feff.language.as_deref(), Some("ts"));
    }

    #[test]
    fn split_block_ends_match_the_blocks_split() {
        // 三个出口同源：ends[i] = 前 i+1 个 stable 块的 UTF-16 累计长度；
        // 末偏移 = stable 前缀的 UTF-16 长度 = findLastStableBlockBoundary。
        // JS 侧据此从自己持有的文本 slice 出块内容与 unstable（热路径契约）。
        for text in [
            "",
            "\n\n",
            "  \n\nx\n\ntail",
            "头部\n\n```js\nconst x = 1",
            "a\n\nb\n\nc",
            "第一段\r\n\r\n第二段",
            "```md\n1. item\n\n> quote\n```\n\ntail",
            "- 项1\n- 项2\n\n新段落",
        ] {
            let split = split_streaming_markdown_blocks(text);
            let ends = split_streaming_markdown_block_ends(text);
            assert_eq!(ends.len(), split.stable_blocks.len(), "text={text:?}");
            let mut units = 0usize;
            for (end, block) in ends.iter().zip(&split.stable_blocks) {
                units += block.encode_utf16().count();
                assert_eq!(*end as usize, units, "text={text:?}");
            }
            let stable_utf16 = split.stable_blocks.concat().encode_utf16().count();
            assert_eq!(
                ends.last().copied().unwrap_or(0) as usize,
                stable_utf16,
                "text={text:?}"
            );
            assert_eq!(find_last_stable_block_boundary(text), stable_utf16);
        }
    }

    #[test]
    fn randomized_prefixes_hold_the_ends_invariants() {
        let mut random = Lcg(0x220_e7d5);
        for case in 0..120 {
            let mut text = String::new();
            let tokens = 8 + random.below(20);
            for _ in 0..tokens {
                text.push_str(TOKENS[random.below(TOKENS.len())]);
            }
            for end in 0..=text.chars().count() {
                let prefix: String = text.chars().take(end).collect();
                let split = split_streaming_markdown_blocks(&prefix);
                let ends = split_streaming_markdown_block_ends(&prefix);
                assert_eq!(
                    ends.len(),
                    split.stable_blocks.len(),
                    "case={case} end={end}"
                );
                let mut units = 0usize;
                for (offset, block) in ends.iter().zip(&split.stable_blocks) {
                    units += block.encode_utf16().count();
                    assert_eq!(*offset as usize, units, "case={case} end={end}");
                }
                assert_eq!(
                    ends.last().copied().unwrap_or(0) as usize,
                    split.stable_blocks.concat().encode_utf16().count(),
                    "case={case} end={end}"
                );
            }
        }
    }

    // ── property-style 随机用例（确定性种子，失败可复现） ────────────────────

    /// mulberry32 同款：小而确定的伪随机（与 TS 侧 fuzz 测试同一形态）。
    struct Lcg(u64);

    impl Lcg {
        fn below(&mut self, bound: usize) -> usize {
            self.0 = self.0.wrapping_add(0x6d2b79f5);
            let mut t = self.0;
            t = t.wrapping_mul(t ^ (t >> 15) | 1);
            t ^= t.wrapping_add(t ^ (t >> 7) | 61);
            let value = ((t ^ (t >> 14)) >> 32) as f64 / u32::MAX as f64;
            ((value * bound as f64).floor() as usize).min(bound - 1)
        }
    }

    /// 记号字母表：行首标记、围栏、空行、CRLF、缩进、制表、行内反引号、非 BMP 字符。
    const TOKENS: &[&str] = &[
        "a",
        "Z",
        "0",
        "1",
        "字",
        "。",
        " ",
        "  ",
        "\n",
        "\n\n",
        "\r\n",
        "\t",
        "    ",
        "|",
        "---",
        "> ",
        ">",
        "- ",
        "-",
        "+ ",
        "* ",
        "1. ",
        "2) ",
        "```",
        "```ts",
        "~~~~",
        "````",
        "`",
        "x`y",
        "~~~",
        "~",
        "🎯",
        "👩‍💻",
        "🇺",
        "🇸",
        "e\u{0301}",
        "    ```",
    ];

    /// 核心不变量：① 拼接还原原文；② unstable 再扫不产生新 stable（边界只提交一次）；
    /// ③ 纯函数确定性；④ stable 块都以换行收尾；⑤ 边界偏移 = stable 的 UTF-16 长度。
    fn assert_split_invariants(text: &str, context: &str) {
        let split = split_streaming_markdown_blocks(text);
        let stable = split.stable_blocks.concat();
        assert_eq!(
            format!("{stable}{}", split.unstable),
            text,
            "拼接还原失败: {context}"
        );
        let rescan = split_streaming_markdown_blocks(&split.unstable);
        assert!(
            rescan.stable_blocks.is_empty(),
            "unstable 内残留已证边界: {context}"
        );
        let twice = split_streaming_markdown_blocks(text);
        assert_eq!(
            twice.stable_blocks, split.stable_blocks,
            "确定性: {context}"
        );
        for block in &split.stable_blocks {
            assert!(block.ends_with('\n'), "stable 块未以换行收尾: {context}");
        }
        assert_eq!(
            find_last_stable_block_boundary(text),
            stable.encode_utf16().count(),
            "UTF-16 边界: {context}"
        );
    }

    #[test]
    fn randomized_prefixes_hold_the_split_invariants() {
        let mut random = Lcg(0x2207_3c0f);
        for case in 0..200 {
            let mut text = String::new();
            let tokens = 8 + random.below(24);
            for _ in 0..tokens {
                text.push_str(TOKENS[random.below(TOKENS.len())]);
            }
            // 逐前缀扫描：切分决策只依赖完整行，前缀序列上的 stable 必须单调前进
            let mut previous_stable = String::new();
            for end in 0..=text.chars().count() {
                let prefix: String = text.chars().take(end).collect();
                assert_split_invariants(&prefix, &format!("case={case} end={end} text={text:?}"));
                let stable = split_streaming_markdown_blocks(&prefix)
                    .stable_blocks
                    .concat();
                assert!(
                    stable.starts_with(&previous_stable),
                    "stable 回退: case={case} end={end}"
                );
                previous_stable = stable;
            }
        }
    }
}
