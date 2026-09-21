//! `#[wasm_bindgen]` 薄壳——JS 出口层。
//!
//! 分层是硬约束（dev-standards「Rust/WASM 计算核」）：**可失败逻辑一律在纯内层**
//! （`Result<T, String>`），这里只做值/错误转换。`JsError::new` 在非 wasm 目标会走
//! 导入桩并 panic，因此壳里不写任何业务判断——壳的每一行都能在宿主上编译，
//! 但只有 wasm 目标会真正执行。
//!
//! 出口清单（与边界约定对应）：
//! - [`parse_markdown`]：整块 markdown 进，渲染模型（root 树）出。流式侧只喂
//!   `splitStreamingMarkdownBlocks` 切出的不稳定尾块，禁止每拍全文。
//! - [`highlight_block`]：整块代码进，行数组 span 出。逐行过界禁止。
//! - `*Json` 变体：serde_json 串出口，供宿主快照/调试工具（parity 快照 bin），
//!   不进浏览器热路径。

use wasm_bindgen::prelude::*;

use crate::highlight::HighlightedLine;
use crate::model::RenderNode;
/// 引擎版本标记（随 crate 版本走），供 JS 侧诊断与 parity 记录。
#[wasm_bindgen(js_name = markdownEngineVersion)]
pub fn markdown_engine_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// markdown 文本 → 渲染模型（结构化值）。
///
/// **必须 `serialize_maps_as_objects(true)`**：`properties` 是 `BTreeMap`，而
/// serde_wasm_bindgen 默认把它编成 JS **`Map`**——于是 `JSON.stringify(node.properties)`
/// 得到 `{}`、按对象读 `properties.href` 得到 `undefined`。表现就是「链接丢 href、
/// 代码块丢 language class、任务列表丢 checked」，而且**只有在消费方忘了把 Map 归一成
/// 对象时才暴露**（TS 侧曾靠 `normalizeNode` 兜着，所以本地测试一直是绿的）。
/// 渲染模型里 `properties` 的语义就是普通对象，边界就该是普通对象。
#[wasm_bindgen(js_name = parseMarkdown)]
pub fn parse_markdown(text: &str) -> Result<JsValue, JsError> {
    use serde::Serialize;
    let model: RenderNode = crate::parser::parse_markdown(text);
    model
        .serialize(&serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true))
        .map_err(|error| JsError::new(&format!("渲染模型序列化失败: {error}")))
}

/// markdown 文本 → 渲染模型 JSON 串（宿主快照/调试用，不进热路径）。
#[wasm_bindgen(js_name = parseMarkdownJson)]
pub fn parse_markdown_json(text: &str) -> Result<String, JsError> {
    let model: RenderNode = crate::parser::parse_markdown(text);
    serde_json::to_string(&model)
        .map_err(|error| JsError::new(&format!("渲染模型 JSON 序列化失败: {error}")))
}

/// 整块代码 → 行数组高亮 span（github `pl-*` 类名链，与 TS 基线 hast 叶子同构）。
/// 语言未知 / 语法包缺失时返回 `null`（与 TS 基线 `highlightCode` 返回 null 同语义）。
#[wasm_bindgen(js_name = highlightBlock)]
pub fn highlight_block(code: &str, language: &str) -> Result<Option<JsValue>, JsError> {
    let lines: Option<Vec<HighlightedLine>> =
        crate::highlight::highlight_block(code, language).map_err(|error| JsError::new(&error))?;
    match lines {
        Some(lines) => serde_wasm_bindgen::to_value(&lines)
            .map(Some)
            .map_err(|error| JsError::new(&format!("高亮结果序列化失败: {error}"))),
        None => Ok(None),
    }
}

/// 整块代码 → 行数组高亮 JSON 串（宿主快照/调试用）。
#[wasm_bindgen(js_name = highlightBlockJson)]
pub fn highlight_block_json(code: &str, language: &str) -> Result<String, JsError> {
    let lines: Option<Vec<HighlightedLine>> =
        crate::highlight::highlight_block(code, language).map_err(|error| JsError::new(&error))?;
    serde_json::to_string(&lines)
        .map_err(|error| JsError::new(&format!("高亮 JSON 序列化失败: {error}")))
}

/// 语言别名 → TextMate scope（与 TS 基线 `scopeForLanguage` 同表）。
#[wasm_bindgen(js_name = scopeForLanguage)]
pub fn scope_for_language(language: &str) -> Option<String> {
    crate::highlight::scope_for_language(language).map(str::to_string)
}
