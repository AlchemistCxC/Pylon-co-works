//! comrak（GFM 扩展）→ [`RenderNode`] 的映射（纯内层，宿主可测）。
//!
//! 目标不是「comrak 的 HTML 输出」，而是 **remark-rehype 的 hast 投影形状**
//! （TS 基线 `markdownRenderModel.ts` 走 unified + remark-gfm + remark-rehype，
//! 再经 `normalizeNode` 收敛成 root/element/text 三种节点）。映射规则凡涉及
//! remark-rehype 的排版细节，一律以 parity 差分实证为准，不凭 HTML 渲染习惯
//! 推断。已实证锁定的排版规则（见 `parity/` 差分工具与 vitest 门禁）：
//!
//! - **容器 `"\n"` 排版**：blockquote / ul / ol / table / thead / tbody / tr 的
//!   子节点是「前导 `"\n"` + 间隔 `"\n"` + 尾随 `"\n"`」包裹；**root 只有间隔**
//!   （无首尾）。这些 `"\n"` 文本节点是结构分隔符，TS 基线 graft 的
//!   `rightmostSpine` 明确依赖这个形状。
//! - **软换行并入文本**：`"a\nb"` 在 mdast 里是**单个** text 节点 `"a\nb"`。
//! - **硬换行 = `br` + 独立的 `"\n"` 文本节点**：换行符自身作为 text 落在 br 之后，
//!   与后续文本不合并。
//! - **任务列表**：ul/ol 带 `className: ["contains-task-list"]`，任务 li 带
//!   `className: ["task-list-item"]`，checkbox `input` 后跟独立的 `" "` 文本节点。
//! - **code 值保留尾换行**：mdast code.value 不剥内容末尾的 `"\n"`。
//! - **URL 空格编码**：mdast 的 url/href/src 把空格编码成 `%20`。
//!
//! 借用结构说明：comrak 的 `children(&'a self)` 要求与节点同生命周期的借用，而
//! `data()` 返回的 `Ref` 会把 `*node` 借住。固定模式是——**先在受限作用域里把本
//! 节点的小载荷拷贝出来，随即释放 `data()` 借用，再遍历子树**。载荷都是小对象，
//! 拷贝成本与产物构建同阶；`CodeBlock` 这类大载荷分支直接 `return` 消费借用。
//!
//! 刻意不做的映射（逐条在 parity 差异清单里过审）：
//! - **HTML 节点直接丢弃**——remark-rehype 未开 `allowDangerousHtml` 时 html 节点
//!   本来就不产出 hast 节点，两侧一致，不是差异。
//! - **footnotes 不启用**——remark-gfm 的脚注 hast 形状（`#user-content-fn-*` 锚点、
//!   文末 section 重排）与 comrak 的 AST 形状差异是结构性的，无法机械映射；
//!   输入带脚注时两侧必然分叉，列入差异清单待裁决。

use comrak::nodes::{AstNode, ListType, NodeValue, TableAlignment};
use comrak::{parse_document, Arena, Options};

use crate::model::{PropValue, RenderNode};

/// GFM 扩展开关——与 remark-gfm 的默认特性集对齐：
/// table / strikethrough / autolink / tasklist。
/// footnotes 刻意关闭（见模块注释），superscript 等非 GFM 扩展不开。
fn gfm_options() -> Options<'static> {
    let mut options = Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.autolink = true;
    options.extension.tasklist = true;
    options
}

/// markdown 文本 → 渲染模型。入口恒返回 `root` 节点（解析本身不失败，
/// CommonMark 对任意输入都有定义；无 Result）。
pub fn parse_markdown(markdown: &str) -> RenderNode {
    let options = gfm_options();
    let arena = Arena::new();
    let root = parse_document(&arena, markdown, &options);
    // root 容器排版：只有子节点之间的 `"\n"` 分隔（无首尾——parity 实证）。
    RenderNode::root(container_flow(
        &convert_block_children(root, &Context::default()),
        Wrap::Between,
    ))
}

/// 走树时需要下传的上下文：表格列对齐（TableCell 按列号取对齐）与
/// 紧凑列表（Item 展平 Paragraph 用）。对齐列用 `Rc` 持有：走树深度不限，
/// 与 comrak 节点借用完全解耦（children() 要求与 arena 同生命周期的借用）。
#[derive(Clone, Default)]
struct Context {
    aligns: Option<std::rc::Rc<[TableAlignment]>>,
    tight_list: bool,
}

/// 块级节点的**已拷贝**载荷判别——存在意义见模块注释「借用结构说明」。
enum BlockKind {
    Paragraph,
    Heading(u8),
    BlockQuote,
    List {
        ordered: bool,
        start: usize,
        tight: bool,
    },
    Item {
        task: Option<bool>,
    },
    Table(std::rc::Rc<[TableAlignment]>),
}

fn convert_block_children<'a>(node: &'a AstNode<'a>, ctx: &Context) -> Vec<RenderNode> {
    let mut result = Vec::new();
    for child in node.children() {
        result.extend(convert_block(child, ctx));
    }
    result
}

fn convert_block<'a>(node: &'a AstNode<'a>, ctx: &Context) -> Vec<RenderNode> {
    // 第一步：受限作用域内拷出小载荷 / 直接消费大载荷（详见模块注释）。
    let kind = {
        let ast = node.data();
        match &ast.value {
            NodeValue::Paragraph => BlockKind::Paragraph,
            NodeValue::Heading(heading) => BlockKind::Heading(heading.level),
            NodeValue::ThematicBreak => {
                return vec![RenderNode::element("hr", vec![])];
            }
            NodeValue::BlockQuote => BlockKind::BlockQuote,
            NodeValue::List(list_meta) => BlockKind::List {
                ordered: list_meta.list_type == ListType::Ordered,
                start: list_meta.start,
                tight: list_meta.tight,
            },
            NodeValue::Item(_) => BlockKind::Item { task: None },
            NodeValue::TaskItem(task) => BlockKind::Item {
                task: Some(task.symbol.is_some()),
            },
            NodeValue::CodeBlock(code) => {
                return render_code_block(code);
            }
            NodeValue::HtmlBlock(_)
            | NodeValue::FootnoteDefinition(_)
            | NodeValue::FrontMatter(_) => {
                return Vec::new();
            }
            NodeValue::Table(table) => {
                BlockKind::Table(std::rc::Rc::from(table.alignments.as_slice()))
            }
            _ => return Vec::new(),
        }
    };

    // 第二步：data() 借用已释放，可自由遍历子树。
    match kind {
        BlockKind::Paragraph => vec![RenderNode::element("p", convert_inline_children(node, ctx))],
        BlockKind::Heading(level) => {
            let tag = format!("h{}", level.min(6));
            vec![RenderNode::element(tag, convert_inline_children(node, ctx))]
        }
        BlockKind::BlockQuote => {
            let children = container_flow(&convert_block_children(node, ctx), Wrap::Around);
            vec![RenderNode::element("blockquote", children)]
        }
        BlockKind::List {
            ordered,
            start,
            tight,
        } => {
            let tag = if ordered { "ol" } else { "ul" };
            let mut properties = std::collections::BTreeMap::new();
            // remark-rehype：ol 只在 start ≠ 1 时带 start 属性（mdast start 缺省 1）。
            if ordered && start != 1 {
                properties.insert("start".to_string(), PropValue::Num(start as i64));
            }
            // GFM 任务列表：容器带 contains-task-list class。
            let has_task = node
                .children()
                .any(|item| matches!(&item.data().value, NodeValue::TaskItem(_)));
            if has_task {
                properties.insert(
                    "className".to_string(),
                    PropValue::List(vec![PropValue::str("contains-task-list")]),
                );
            }
            let item_ctx = Context {
                aligns: ctx.aligns.clone(),
                tight_list: tight,
            };
            let mut items = Vec::new();
            for item in node.children() {
                items.extend(convert_block(item, &item_ctx));
            }
            vec![RenderNode::element_with(
                tag,
                properties,
                container_flow(&items, Wrap::Around),
            )]
        }
        BlockKind::Item { task } => render_list_item(node, ctx, task),
        BlockKind::Table(aligns) => render_table(node, aligns),
    }
}

/// 代码块：mdast code.value **保留**内容行尾换行（parity 实证）；micromark 语义里
/// 代码行恒以换行终止（未闭合围栏在 EOF 也补虚拟换行），因此 literal 缺尾换行时补上。
/// mdast code.lang 取 info string 首个空白分隔词；hast className = ['language-' + lang]。
fn render_code_block(code: &comrak::nodes::NodeCodeBlock) -> Vec<RenderNode> {
    let mut properties = std::collections::BTreeMap::new();
    let lang = code.info.split_whitespace().next().unwrap_or("");
    if !lang.is_empty() {
        properties.insert(
            "className".to_string(),
            PropValue::List(vec![PropValue::str(format!("language-{lang}"))]),
        );
    }
    let mut value = code.literal.clone();
    if !value.ends_with('\n') {
        value.push('\n');
    }
    // 空代码块（` ```\n``` `）：micromark 产出空串，comrak literal 是单个换行。
    if value == "\n" {
        value.clear();
    }
    let code_element = RenderNode::element_with("code", properties, vec![RenderNode::text(value)]);
    vec![RenderNode::element("pre", vec![code_element])]
}

/// 列表项（parity 实证的形状）：
/// - **紧凑** li：首块 Paragraph 展平为行内内容；其后还有块（嵌套列表等）时，
///   剩余块整体 `"\n"` 包裹（`[text a, "\n", ul, "\n"]`）。
/// - **松散** li：所有块整体 `"\n"` 包裹（单段即 `["\n", p, "\n"]`），不展平。
/// - 任务项带 `task-list-item` class，checkbox `input` 后跟独立的 `" "` 文本节点。
fn render_list_item<'a>(
    node: &'a AstNode<'a>,
    ctx: &Context,
    task: Option<bool>,
) -> Vec<RenderNode> {
    let blocks: Vec<&AstNode<'a>> = node.children().collect();
    let mut children: Vec<RenderNode> = Vec::new();
    if ctx.tight_list {
        let mut rest = blocks.as_slice();
        if let Some(first) = blocks.first() {
            if matches!(&first.data().value, NodeValue::Paragraph) {
                children.extend(convert_inline_children(first, ctx));
                rest = &blocks[1..];
            }
        }
        if !rest.is_empty() {
            let mut wrapped = Vec::new();
            for block in rest {
                wrapped.extend(convert_block(block, ctx));
            }
            children.extend(container_flow(&wrapped, Wrap::Around));
        }
    } else {
        let mut wrapped = Vec::new();
        for block in &blocks {
            wrapped.extend(convert_block(block, ctx));
        }
        children.extend(container_flow(&wrapped, Wrap::Around));
    }

    let mut properties = std::collections::BTreeMap::new();
    if let Some(is_checked) = task {
        properties.insert(
            "className".to_string(),
            PropValue::List(vec![PropValue::str("task-list-item")]),
        );
        let mut input_properties = std::collections::BTreeMap::new();
        input_properties.insert("type".to_string(), PropValue::str("checkbox"));
        input_properties.insert("checked".to_string(), PropValue::Bool(is_checked));
        input_properties.insert("disabled".to_string(), PropValue::Bool(true));
        let input = RenderNode::element_with("input", input_properties, vec![]);
        children.insert(0, RenderNode::text(" "));
        children.insert(0, input);
    }

    vec![RenderNode::element_with("li", properties, children)]
}

/// 表格：remark-rehype 的结构是 table > thead(一行 th) + tbody(多行 td)，
/// 对齐列以 `style: "text-align:*"` 落在 th/td 上；每层容器都带 `"\n"` 包裹。
fn render_table<'a>(
    node: &'a AstNode<'a>,
    aligns: std::rc::Rc<[TableAlignment]>,
) -> Vec<RenderNode> {
    let table_ctx = Context {
        aligns: Some(aligns.clone()),
        tight_list: false,
    };
    let mut thead = Vec::new();
    let mut tbody = Vec::new();
    for row in node.children() {
        let row_ast = row.data();
        let is_header = matches!(&row_ast.value, NodeValue::TableRow(true));
        drop(row_ast);
        let mut cells = Vec::new();
        for cell in row.children() {
            if !matches!(&cell.data().value, NodeValue::TableCell) {
                continue;
            }
            let tag = if is_header { "th" } else { "td" };
            let mut properties = std::collections::BTreeMap::new();
            // parity 实证：对齐落在 `align` 属性（"left"/"center"/"right"），不是 style。
            let align = match aligns.get(cells.len()) {
                Some(TableAlignment::Left) => Some("left"),
                Some(TableAlignment::Center) => Some("center"),
                Some(TableAlignment::Right) => Some("right"),
                _ => None,
            };
            if let Some(align) = align {
                properties.insert("align".to_string(), PropValue::str(align));
            }
            cells.push(RenderNode::element_with(
                tag,
                properties,
                convert_inline_children(cell, &table_ctx),
            ));
        }
        let row_element = RenderNode::element("tr", container_flow(&cells, Wrap::Around));
        if is_header {
            thead.push(row_element);
        } else {
            tbody.push(row_element);
        }
    }
    let mut children = Vec::new();
    if !thead.is_empty() {
        children.push(RenderNode::element(
            "thead",
            container_flow(&thead, Wrap::Around),
        ));
    }
    if !tbody.is_empty() {
        children.push(RenderNode::element(
            "tbody",
            container_flow(&tbody, Wrap::Around),
        ));
    }
    vec![RenderNode::element(
        "table",
        container_flow(&children, Wrap::Around),
    )]
}

/// 行内子树转换：核心是**文本合并缓冲**——mdast 的 text 节点横跨软换行
/// （`"a\nb"` 是单节点），comrak 则拆成 Text/SoftBreak/Text；缓冲把两者对齐。
fn convert_inline_children<'a>(node: &'a AstNode<'a>, ctx: &Context) -> Vec<RenderNode> {
    let mut result: Vec<RenderNode> = Vec::new();
    let mut buffer = String::new();
    for child in node.children() {
        let kind = inline_kind(child);
        match kind {
            InlineKind::Text(value) => buffer.push_str(&value),
            InlineKind::SoftBreak => buffer.push('\n'),
            // 行内 html 被两侧丢弃，但它是 mdast 文本节点的**边界**（实证：
            // `a <b>c</b> d` 在 TS 侧是三个 text 节点），所以只 flush 不产出。
            InlineKind::HtmlInline => flush_text(&mut buffer, &mut result),
            InlineKind::Structured => {
                flush_text(&mut buffer, &mut result);
                result.extend(convert_inline_structured(child, ctx));
            }
        }
    }
    flush_text(&mut buffer, &mut result);
    result
}

fn flush_text(buffer: &mut String, result: &mut Vec<RenderNode>) {
    if !buffer.is_empty() {
        result.push(RenderNode::text(buffer.drain(..).as_str()));
    }
}

/// 行内节点的**已拷贝**载荷判别（同 BlockKind 的借用理由）。
enum InlineKind {
    Text(String),
    SoftBreak,
    HtmlInline,
    /// 有独立元素形状的节点（br/code/em/…），进结构化转换。
    Structured,
}

fn inline_kind<'a>(node: &'a AstNode<'a>) -> InlineKind {
    let ast = node.data();
    match &ast.value {
        NodeValue::Text(value) => InlineKind::Text(value.to_string()),
        NodeValue::SoftBreak => InlineKind::SoftBreak,
        NodeValue::HtmlInline(_) => InlineKind::HtmlInline,
        _ => InlineKind::Structured,
    }
}

/// 结构化行内节点 → 0..n 个模型节点。调用前文本缓冲已 flush。
fn convert_inline_structured<'a>(node: &'a AstNode<'a>, ctx: &Context) -> Vec<RenderNode> {
    /// 强调系标签（同构映射，合一处理）。
    enum Mark {
        Em,
        Strong,
        Del,
    }
    let mark = {
        let ast = node.data();
        match &ast.value {
            NodeValue::LineBreak => {
                return vec![
                    RenderNode::element("br", vec![]),
                    // 实证：换行符自身是 br 之后的**独立** `"\n"` 文本节点，与后续文本不合并。
                    RenderNode::text("\n"),
                ];
            }
            NodeValue::Code(code) => {
                return vec![RenderNode::element(
                    "code",
                    vec![RenderNode::text(code.literal.clone())],
                )];
            }
            NodeValue::Emph => Some(Mark::Em),
            NodeValue::Strong => Some(Mark::Strong),
            NodeValue::Strikethrough => Some(Mark::Del),
            NodeValue::Link(link) => {
                let children = convert_inline_children(node, ctx);
                return vec![RenderNode::element_with(
                    "a",
                    link_properties(&link.url, &link.title),
                    children,
                )];
            }
            NodeValue::Image(link) => {
                // mdast image.alt 是解析期算好的字符串（标签内联文本的纯文本投影，
                // 换行保持 `"\n"`——parity 实证，不是空格）。
                let mut properties = std::collections::BTreeMap::new();
                properties.insert("src".to_string(), PropValue::str(normalize_url(&link.url)));
                properties.insert("alt".to_string(), PropValue::str(collect_alt_text(node)));
                if !link.title.is_empty() {
                    properties.insert("title".to_string(), PropValue::str(link.title.clone()));
                }
                return vec![RenderNode::element_with("img", properties, vec![])];
            }
            _ => None,
        }
    };
    let tag = match mark {
        Some(Mark::Em) => "em",
        Some(Mark::Strong) => "strong",
        Some(Mark::Del) => "del",
        None => return Vec::new(),
    };
    vec![RenderNode::element(tag, convert_inline_children(node, ctx))]
}

/// a/img 的公共属性形状。mdast 的 url 把空格编码为 `%20`（parity 实证）；
/// title：mdast 无 title 时是 null，comrak 是空串，只能按「空串 = 无 title」
/// 收敛——`[a](u "")` 显式空 title 是已知边缘差异（见 parity 清单）。
fn link_properties(url: &str, title: &str) -> std::collections::BTreeMap<String, PropValue> {
    let mut properties = std::collections::BTreeMap::new();
    properties.insert("href".to_string(), PropValue::str(normalize_url(url)));
    if !title.is_empty() {
        properties.insert("title".to_string(), PropValue::str(title));
    }
    properties
}

/// mdast 对 destination 的 normalizeUri 语义（micromark 解析期行为，parity 实证）：
/// - 空格 / ASCII 控制符 / DEL / 非 ASCII → UTF-8 百分号编码；
/// - `%` 后面不是两位十六进制时按字面量重编码成 `%25`（防歧义）；
/// - 其余 ASCII 可打印字符原样保留（含 `[]()` 等）。
fn normalize_url(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        // `%` 后两位都是十六进制 → 视作合法转义原样保留。
        if byte == b'%'
            && index + 2 < bytes.len()
            && bytes[index + 1].is_ascii_hexdigit()
            && bytes[index + 2].is_ascii_hexdigit()
        {
            result.push('%');
            index += 1;
            continue;
        }
        // 以「字符」为单位判断再取其 UTF-8 字节编码（非 ASCII 一并处理）。
        let rest = &value[index..];
        let ch = rest.chars().next().expect("index 落在字符边界");
        let is_safe_ascii = (0x21..=0x7e).contains(&byte) && byte != b'%';
        if is_safe_ascii {
            result.push(ch);
        } else {
            let mut encoded = [0u8; 4];
            for byte in ch.encode_utf8(&mut encoded).as_bytes() {
                result.push_str(&format!("%{byte:02X}"));
            }
        }
        index += ch.len_utf8();
    }
    result
}

/// 图片 alt：comrak 把标签内联放在 children；mdast 的 alt = 文本投影
/// （Text/Code 取值，软换行保持 `"\n"`——parity 实证）。
fn collect_alt_text<'a>(node: &'a AstNode<'a>) -> String {
    let mut result = String::new();
    for child in node.children() {
        let child_ast = child.data();
        match &child_ast.value {
            NodeValue::Text(value) => result.push_str(value),
            NodeValue::Code(code) => result.push_str(&code.literal),
            NodeValue::SoftBreak | NodeValue::LineBreak => result.push('\n'),
            _ => {
                drop(child_ast);
                result.push_str(&collect_alt_text(child));
            }
        }
    }
    result
}

/// remark-rehype 的容器 `"\n"` 排版（模块注释「容器排版」）。
#[derive(Clone, Copy, PartialEq, Eq)]
enum Wrap {
    /// root：只有子节点之间的 `"\n"`（无首尾）。
    Between,
    /// blockquote / ul / ol / table / thead / tbody / tr：前导 + 间隔 + 尾随。
    Around,
}

fn container_flow(children: &[RenderNode], wrap: Wrap) -> Vec<RenderNode> {
    let mut result = Vec::with_capacity(children.len() * 2 + 2);
    if wrap == Wrap::Around {
        result.push(RenderNode::text("\n"));
    }
    for (index, child) in children.iter().enumerate() {
        if index > 0 {
            result.push(RenderNode::text("\n"));
        }
        result.push(child.clone());
    }
    if wrap == Wrap::Around {
        result.push(RenderNode::text("\n"));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::RenderNode;

    /// JSON 便捷断言：把模型转成 serde_json::Value 再查路径。
    fn json(model: &RenderNode) -> serde_json::Value {
        serde_json::to_value(model).expect("渲染模型必然可序列化")
    }

    fn parse(input: &str) -> serde_json::Value {
        json(&parse_markdown(input))
    }

    /// 容器排版（root）：段间有 `"\n"` 分隔、无首尾。
    #[test]
    fn root_children_joined_by_newlines() {
        let model = parse("first\n\nsecond");
        assert_eq!(
            model["children"].as_array().expect("root 有子节点").len(),
            3
        );
        assert_eq!(model["children"][0]["tagName"], "p");
        assert_eq!(model["children"][1]["value"], "\n");
        assert_eq!(model["children"][2]["tagName"], "p");
    }

    /// 软换行并入文本：`"a\nb"` 是单个 text 节点。
    #[test]
    fn softbreak_merges_into_text() {
        let model = parse("a\nb");
        let children = model["children"][0]["children"].as_array().unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0]["value"], "a\nb");
    }

    /// 硬换行 = br + 独立的 `"\n"` 文本节点（与后续文本不合并）。
    #[test]
    fn hardbreak_is_br_plus_newline_text() {
        let model = parse("a  \nb");
        let children = model["children"][0]["children"].as_array().unwrap();
        let tags: Vec<&str> = children
            .iter()
            .map(|child| child["type"].as_str().unwrap())
            .collect();
        assert_eq!(tags, vec!["text", "element", "text", "text"]);
        assert_eq!(children[1]["tagName"], "br");
        assert_eq!(children[2]["value"], "\n");
        assert_eq!(children[3]["value"], "b");
    }

    /// 围栏代码块：value 保留尾换行；lang 取 info 首词且大小写原样。
    #[test]
    fn fenced_code_keeps_trailing_newline_and_lang_case() {
        let model = parse("```TS ignore\nconst x\n```");
        let code = &model["children"][0]["children"][0];
        assert_eq!(code["tagName"], "code");
        assert_eq!(code["properties"]["className"][0], "language-TS");
        assert_eq!(code["children"][0]["value"], "const x\n");
    }

    /// 未闭合围栏（流式尾块形态）：micromark 语义补虚拟换行。
    #[test]
    fn unclosed_fence_gets_virtual_newline() {
        let model = parse("```ts\nconst x = 1;");
        assert_eq!(
            model["children"][0]["children"][0]["children"][0]["value"],
            "const x = 1;\n"
        );
    }

    /// 空围栏：micromark 产出空串（不是单个换行）。
    #[test]
    fn empty_fence_is_empty_string() {
        let model = parse("```\n```");
        assert_eq!(
            model["children"][0]["children"][0]["children"][0]["value"],
            ""
        );
    }

    /// 任务列表：容器与项的 class、checkbox 属性、input 后独立空格文本。
    #[test]
    fn task_list_shape() {
        let model = parse("- [x] done");
        let ul = &model["children"][0];
        assert_eq!(ul["properties"]["className"][0], "contains-task-list");
        let li = &ul["children"][1];
        assert_eq!(li["properties"]["className"][0], "task-list-item");
        assert_eq!(li["children"][0]["tagName"], "input");
        assert_eq!(li["children"][0]["properties"]["checked"], true);
        assert_eq!(li["children"][0]["properties"]["disabled"], true);
        assert_eq!(li["children"][1]["value"], " ");
        assert_eq!(li["children"][2]["value"], "done");
    }

    /// 有序列表：start ≠ 1 才带 start 属性。
    #[test]
    fn ordered_list_start_property() {
        assert!(parse("1. a")["children"][0]["properties"]
            .get("start")
            .is_none());
        assert_eq!(parse("5. a")["children"][0]["properties"]["start"], 5);
    }

    /// 松散列表项：块整体 `"\n"` 包裹（`["\n", p, "\n"]`）。
    #[test]
    fn loose_list_item_wraps_blocks() {
        let model = parse("- a\n\n- b");
        let li = &model["children"][0]["children"][1];
        let children = li["children"].as_array().unwrap();
        assert_eq!(children.len(), 3);
        assert_eq!(children[0]["value"], "\n");
        assert_eq!(children[1]["tagName"], "p");
        assert_eq!(children[2]["value"], "\n");
    }

    /// 紧凑列表项 + 嵌套列表：行内平铺后剩余块 `"\n"` 包裹（`[a, "\n", ul, "\n"]`）。
    #[test]
    fn tight_list_item_flattens_paragraph_and_wraps_rest() {
        let model = parse("- a\n  - b");
        let li = &model["children"][0]["children"][1];
        let children = li["children"].as_array().unwrap();
        assert_eq!(children.len(), 4);
        assert_eq!(children[0]["value"], "a");
        assert_eq!(children[1]["value"], "\n");
        assert_eq!(children[2]["tagName"], "ul");
        assert_eq!(children[3]["value"], "\n");
    }

    /// 表格对齐：`align` 属性（"left"/"center"/"right"），无对齐列无属性。
    #[test]
    fn table_alignment_uses_align_property() {
        let model = parse("| l | n |\n| :- | - |\n| 1 | 2 |");
        let th = &model["children"][0]["children"][1]["children"][1]["children"][1];
        assert_eq!(th["properties"]["align"], "left");
        let td = &model["children"][0]["children"][3]["children"][1]["children"][1];
        assert_eq!(td["properties"]["align"], "left");
        let td_none = &model["children"][0]["children"][3]["children"][1]["children"][3];
        assert!(td_none["properties"].get("align").is_none());
    }

    /// 行内 html 被丢弃但保留文本边界：三个独立 text 节点。
    #[test]
    fn inline_html_splits_text_boundary() {
        let model = parse("a <b>c</b> d");
        let children = model["children"][0]["children"].as_array().unwrap();
        let values: Vec<&str> = children
            .iter()
            .map(|child| child["value"].as_str().unwrap())
            .collect();
        assert_eq!(values, vec!["a ", "c", " d"]);
    }

    /// normalizeUrl：空格/非 ASCII 百分号编码；合法 `%XX` 转义保留。
    #[test]
    fn url_normalization() {
        assert_eq!(normalize_url("u v"), "u%20v");
        assert_eq!(normalize_url("/路径"), "/%E8%B7%AF%E5%BE%84");
        assert_eq!(normalize_url("a.b?x=1&y=2"), "a.b?x=1&y=2");
        assert_eq!(normalize_url("%20"), "%20");
        assert_eq!(normalize_url("50% off"), "50%25%20off");
    }

    /// HTML 块丢弃（两侧一致）：只剩后面的段落；GFM 删除线 → del。
    #[test]
    fn html_block_dropped_and_strikethrough_is_del() {
        let model = parse("<div>x</div>\n\ntext");
        let children = model["children"].as_array().unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0]["tagName"], "p");
        let model = parse("~~gone~~");
        assert_eq!(model["children"][0]["children"][0]["tagName"], "del");
    }
}
