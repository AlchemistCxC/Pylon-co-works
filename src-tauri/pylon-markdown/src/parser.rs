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
//! - **footnotes 已启用**（#267 裁决，ADR-0021）——历史「刻意关闭」在此关闭：形状对齐
//!   remark-gfm/rehype（`user-content-*` 锚点 + 文末 `section[data-footnotes]`），
//!   旧差异清单的 footnote 分叉项随之收敛；corpus `footnote-probe` 转为锁定渲染形状。
//! - **math 已启用**（#267，`math_dollars`）——remark-math 的 hast 形状：
//!   行内 `span.math.math-inline`、显示 `div.math.math-display`，latex 作为唯一
//!   文本子节点（comrak 不展开 latex 内容，语义一致）。`math_code` 不开（remark-math 无此物）。

use comrak::nodes::{AstNode, ListType, NodeValue, TableAlignment};
use comrak::{parse_document, Arena, Options};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::model::{PropValue, RenderNode};

/// GFM 扩展开关——与 remark-gfm 的默认特性集对齐：
/// table / strikethrough / autolink / tasklist，另加 #267 的 math_dollars 与
/// footnotes（二者均为 remark-gfm 面内的特性；superscript 等非 GFM 扩展不开）。
fn gfm_options() -> Options<'static> {
    let mut options = Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.autolink = true;
    options.extension.tasklist = true;
    options.extension.math_dollars = true;
    options.extension.footnotes = true;
    options
}

/// markdown 文本 → 渲染模型。入口恒返回 `root` 节点（解析本身不失败，
/// CommonMark 对任意输入都有定义；无 Result）。
///
/// 脚注两遍走树（#267）：第一遍按**文档序首引用**给名字编号（定义体位于
/// root 子级尾部，其内部引用天然排在正文引用之后）；第二遍转换正文并按编号
/// 在 root 末尾追加文末脚注节（有定义且被引用者才收）。
pub fn parse_markdown(markdown: &str) -> RenderNode {
    let options = gfm_options();
    let arena = Arena::new();
    let root = parse_document(&arena, markdown, &options);
    let mut footnotes = FootnoteNumbers::default();
    let mut next = 0u32;
    collect_footnote_numbers(root, &mut footnotes, &mut next);
    let ctx = Context {
        aligns: None,
        tight_list: false,
        footnotes: Some(Rc::new(footnotes)),
    };
    let mut children = convert_block_children(root, &ctx);
    if let Some(section) = build_footnote_section(root, &ctx) {
        children.push(section);
    }
    // root 容器排版：只有子节点之间的 `"\n"` 分隔（无首尾——parity 实证）。
    RenderNode::root(container_flow(&children, Wrap::Between))
}

/// 脚注编号状态：name → 展示编号（首引用序，1 起）。`ref_counts` 供第二遍为
/// 同名多次引用生成唯一锚 id（首次 `user-content-fnref-N`，后续 `-k` 后缀）。
#[derive(Default)]
struct FootnoteNumbers {
    numbers: HashMap<String, u32>,
    ref_counts: RefCell<HashMap<String, u32>>,
}

/// 第一遍：文档序（先序）收集「名字 → 展示编号」。
fn collect_footnote_numbers<'a>(
    node: &'a AstNode<'a>,
    state: &mut FootnoteNumbers,
    next: &mut u32,
) {
    if let NodeValue::FootnoteReference(reference) = &node.data().value {
        state
            .numbers
            .entry(reference.name.clone())
            .or_insert_with(|| {
                *next += 1;
                *next
            });
    }
    for child in node.children() {
        collect_footnote_numbers(child, state, next);
    }
}

/// 找同名脚注定义（comrak 把定义作为 root 子级，名字唯一时恰一个）。
fn find_footnote_definition<'a>(root: &'a AstNode<'a>, name: &str) -> Option<&'a AstNode<'a>> {
    root.children().find(|child| {
        matches!(
            &child.data().value,
            NodeValue::FootnoteDefinition(definition) if definition.name == name
        )
    })
}

/// 文末脚注节：`section[data-footnotes].footnotes > ol > li#user-content-fn-N`。
/// 只收「有定义且被引用」的名字，按展示编号排序；未被引用的定义不收（与
/// remark-rehype 一致——引用了未定义名字时引用仍渲染、节内无条目）。
fn build_footnote_section<'a>(root: &'a AstNode<'a>, ctx: &Context) -> Option<RenderNode> {
    let numbers = ctx.footnotes.as_ref()?;
    let mut ordered: Vec<(u32, &String)> = numbers
        .numbers
        .iter()
        .map(|(name, &number)| (number, name))
        .collect();
    ordered.sort();
    let mut items = Vec::new();
    for (number, name) in ordered {
        let Some(definition) = find_footnote_definition(root, name) else {
            continue;
        };
        let mut blocks = Vec::new();
        for block in definition.children() {
            blocks.extend(convert_block(block, ctx));
        }
        // 回链塞进最后一个块元素（通常是 p）的内容末尾——cmark-gfm/remark 同位。
        let mut back_properties = std::collections::BTreeMap::new();
        back_properties.insert(
            "href".to_string(),
            PropValue::str(format!("#user-content-fnref-{number}")),
        );
        back_properties.insert("dataFootnoteBackref".to_string(), PropValue::Bool(true));
        back_properties.insert(
            "className".to_string(),
            PropValue::List(vec![PropValue::str("footnote-backref")]),
        );
        back_properties.insert(
            "ariaLabel".to_string(),
            PropValue::str(format!("Back to reference {number}")),
        );
        let backref = RenderNode::element_with("a", back_properties, vec![RenderNode::text("↩")]);
        match blocks.last_mut() {
            Some(RenderNode::Element { children, .. }) => children.push(backref),
            _ => blocks.push(backref),
        }
        let mut li_properties = std::collections::BTreeMap::new();
        li_properties.insert(
            "id".to_string(),
            PropValue::str(format!("user-content-fn-{number}")),
        );
        items.push(RenderNode::element_with(
            "li",
            li_properties,
            container_flow(&blocks, Wrap::Around),
        ));
    }
    if items.is_empty() {
        return None;
    }
    let mut section_properties = std::collections::BTreeMap::new();
    section_properties.insert("dataFootnotes".to_string(), PropValue::Bool(true));
    section_properties.insert(
        "className".to_string(),
        PropValue::List(vec![PropValue::str("footnotes")]),
    );
    Some(RenderNode::element_with(
        "section",
        section_properties,
        container_flow(
            &[RenderNode::element(
                "ol",
                container_flow(&items, Wrap::Around),
            )],
            Wrap::Around,
        ),
    ))
}

/// 走树时需要下传的上下文：表格列对齐（TableCell 按列号取对齐）、
/// 紧凑列表（Item 展平 Paragraph 用）与脚注编号（#267，第一遍产物只读共享）。
/// 对齐列用 `Rc` 持有：走树深度不限，与 comrak 节点借用完全解耦
/// （children() 要求与 arena 同生命周期的借用）。
#[derive(Clone)]
struct Context {
    aligns: Option<std::rc::Rc<[TableAlignment]>>,
    tight_list: bool,
    footnotes: Option<Rc<FootnoteNumbers>>,
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
        BlockKind::Paragraph => match solo_display_math(node) {
            // #267：整段只有一个显示公式（允许纯空白文本/软换行夹杂）时提升为
            // 块级 `div.math-display`——对应 remark-math 的 flow math；其余一律
            // 走行内路径（span）。
            Some(latex) => vec![math_display_element(latex)],
            None => vec![RenderNode::element("p", convert_inline_children(node, ctx))],
        },
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
                footnotes: ctx.footnotes.clone(),
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
        BlockKind::Table(aligns) => render_table(node, aligns, ctx),
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
    ctx: &Context,
) -> Vec<RenderNode> {
    let table_ctx = Context {
        aligns: Some(aligns.clone()),
        tight_list: false,
        footnotes: ctx.footnotes.clone(),
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

/// #267：段落级显示公式提升判据——全部子节点中恰有一个 `display_math` 的
/// Math 节点，其余只允许空白文本/软换行。返回该节点的 latex。
fn solo_display_math<'a>(node: &'a AstNode<'a>) -> Option<String> {
    let mut math: Option<String> = None;
    for child in node.children() {
        match &child.data().value {
            NodeValue::Math(m) if m.display_math => {
                if math.is_some() {
                    return None;
                }
                math = Some(m.literal.clone());
            }
            NodeValue::Text(text) if text.trim().is_empty() => {}
            NodeValue::SoftBreak => {}
            _ => return None,
        }
    }
    math
}

/// `div.math.math-display`，latex 为唯一文本子节点。
fn math_display_element(latex: String) -> RenderNode {
    let mut properties = std::collections::BTreeMap::new();
    properties.insert(
        "className".to_string(),
        PropValue::List(vec![PropValue::str("math"), PropValue::str("math-display")]),
    );
    RenderNode::element_with("div", properties, vec![RenderNode::text(latex)])
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
            NodeValue::Math(math) => {
                // #267：remark-math 的 hast 形状。comrak 的 Math 恒为行内节点
                // （`$$` 也一样，见 comrak tests/math.rs），「整段纯显示公式」在
                // 块级提升为 `div.math-display`（见 convert_block 的 Paragraph 臂）；
                // 行内位置一律 `span.math-inline`（避免 div 落进 p 的非法嵌套）。
                let mut properties = std::collections::BTreeMap::new();
                properties.insert(
                    "className".to_string(),
                    PropValue::List(vec![PropValue::str("math"), PropValue::str("math-inline")]),
                );
                return vec![RenderNode::element_with(
                    "span",
                    properties,
                    vec![RenderNode::text(math.literal.clone())],
                )];
            }
            NodeValue::FootnoteReference(reference) => {
                // #267：remark-gfm/rehype 形状——sup > a[href=#user-content-fn-N]。
                // 编号来自第一遍首引用序；同名多次引用的锚 id 加 -k 后缀保唯一。
                let Some(numbers) = &ctx.footnotes else {
                    return Vec::new();
                };
                let Some(&number) = numbers.numbers.get(&reference.name) else {
                    return Vec::new();
                };
                let occurrence = {
                    let mut counts = numbers.ref_counts.borrow_mut();
                    let count = counts.entry(reference.name.clone()).or_insert(0);
                    *count += 1;
                    *count
                };
                let reference_id = if occurrence == 1 {
                    format!("user-content-fnref-{number}")
                } else {
                    format!("user-content-fnref-{number}-{occurrence}")
                };
                let mut anchor_properties = std::collections::BTreeMap::new();
                anchor_properties.insert(
                    "href".to_string(),
                    PropValue::str(format!("#user-content-fn-{number}")),
                );
                anchor_properties.insert("id".to_string(), PropValue::str(reference_id));
                anchor_properties.insert("dataFootnoteRef".to_string(), PropValue::Bool(true));
                let anchor = RenderNode::element_with(
                    "a",
                    anchor_properties,
                    vec![RenderNode::text(number.to_string())],
                );
                let mut sup_properties = std::collections::BTreeMap::new();
                sup_properties.insert(
                    "ariaLabel".to_string(),
                    PropValue::str(format!("Reference {number}")),
                );
                return vec![RenderNode::element_with(
                    "sup",
                    sup_properties,
                    vec![anchor],
                )];
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

    /// #267 行内数学：`span.math.math-inline`，latex 为唯一文本子节点。
    #[test]
    fn inline_math_is_span_with_latex_text() {
        let model = parse("动力 $f(x)=x^{2}$ 的导数");
        let children = model["children"][0]["children"].as_array().unwrap();
        assert_eq!(children.len(), 3);
        assert_eq!(children[0]["value"], "动力 ");
        assert_eq!(children[1]["tagName"], "span");
        assert_eq!(children[1]["properties"]["className"][0], "math");
        assert_eq!(children[1]["properties"]["className"][1], "math-inline");
        assert_eq!(children[1]["children"][0]["value"], "f(x)=x^{2}");
        assert_eq!(children[2]["value"], " 的导数");
    }

    /// #267 显示数学：`div.math.math-display`（顶层块）。literal 具体是否含
    /// 界内换行随 comrak，断言只锁 tagName/class 与 latex 内容存在。
    #[test]
    fn display_math_is_div_with_latex_text() {
        let model = parse("$$\nS=\\sum_{n=1}^{\\infty}\\frac{1}{n^{2}}\n$$");
        let block = &model["children"][0];
        assert_eq!(block["tagName"], "div");
        assert_eq!(block["properties"]["className"][0], "math");
        assert_eq!(block["properties"]["className"][1], "math-display");
        let latex = block["children"][0]["value"].as_str().unwrap();
        assert!(latex.contains("S=\\sum"), "latex 原文保留: {latex:?}");
    }

    /// #267 脚注：引用 → `sup > a[data-footnote-ref]`（首引用锚无后缀），
    /// 文末 `section[data-footnotes].footnotes > ol > li#user-content-fn-1`，
    /// 回链塞进定义末块（p）内容尾。
    #[test]
    fn footnote_reference_definition_and_section() {
        let model = parse("Hi[^1]\n\n[^1]: A greeting.");
        let children = model["children"].as_array().unwrap();
        // 正文段落 + "\n" + section
        assert_eq!(children.len(), 3);
        assert_eq!(children[0]["tagName"], "p");
        let sup = &children[0]["children"][1];
        assert_eq!(sup["tagName"], "sup");
        assert_eq!(sup["children"][0]["tagName"], "a");
        assert_eq!(
            sup["children"][0]["properties"]["href"],
            "#user-content-fn-1"
        );
        assert_eq!(
            sup["children"][0]["properties"]["id"],
            "user-content-fnref-1"
        );
        assert_eq!(sup["children"][0]["properties"]["dataFootnoteRef"], true);
        assert_eq!(sup["children"][0]["children"][0]["value"], "1");

        let section = &children[2];
        assert_eq!(section["tagName"], "section");
        assert_eq!(section["properties"]["dataFootnotes"], true);
        assert_eq!(section["properties"]["className"][0], "footnotes");
        let ol = &section["children"][1];
        assert_eq!(ol["tagName"], "ol");
        let li = &ol["children"][1];
        assert_eq!(li["properties"]["id"], "user-content-fn-1");
        let p = &li["children"][1];
        assert_eq!(p["tagName"], "p");
        let backref = &p["children"][1];
        assert_eq!(backref["tagName"], "a");
        assert_eq!(backref["properties"]["href"], "#user-content-fnref-1");
        assert_eq!(backref["properties"]["dataFootnoteBackref"], true);
        assert_eq!(backref["properties"]["className"][0], "footnote-backref");
        assert_eq!(backref["children"][0]["value"], "↩");
    }

    /// #267 编号与多引：编号按**首引用序**；同名二次引用锚加 `-2` 后缀；
    /// 回链恒指首引用锚。
    #[test]
    fn footnote_numbering_follows_first_reference_order() {
        let model = parse("b[^note] then a[^other]\n\nmore[^note]\n\n[^note]: N\n[^other]: O");
        let children = model["children"].as_array().unwrap();
        let first = &children[0]["children"][1];
        assert_eq!(
            first["children"][0]["properties"]["href"],
            "#user-content-fn-1"
        );
        assert_eq!(first["children"][0]["children"][0]["value"], "1");
        let second = &children[0]["children"][3];
        assert_eq!(
            second["children"][0]["properties"]["href"],
            "#user-content-fn-2"
        );
        assert_eq!(second["children"][0]["children"][0]["value"], "2");
        // 第二段的重复引用：编号仍 1，锚 id 带 -2 后缀
        let repeat = &children[2]["children"][1];
        assert_eq!(
            repeat["children"][0]["properties"]["id"],
            "user-content-fnref-1-2"
        );
        // section 内两个 li 的 id 顺序 = 编号序
        let ol = &children[4]["children"][1];
        assert_eq!(ol["children"][1]["properties"]["id"], "user-content-fn-1");
        assert_eq!(ol["children"][3]["properties"]["id"], "user-content-fn-2");
    }

    /// #267 引用了未定义的名字：comrak/remark-gfm 同语义——不产引用节点，
    /// 保持字面文本 `[^ghost]`（内容不丢）。
    #[test]
    fn footnote_without_definition_stays_literal() {
        let model = parse("Hi[^ghost]");
        let children = model["children"][0]["children"].as_array().unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0]["value"], "Hi[^ghost]");
    }

    /// #267 行中 `$$…$$`：不提升（div 落进 p 是非法嵌套），保持行内 span。
    #[test]
    fn display_math_mid_text_stays_inline_span() {
        let model = parse("text $$a+b$$ more");
        let children = model["children"][0]["children"].as_array().unwrap();
        assert_eq!(children[0]["value"], "text ");
        assert_eq!(children[1]["tagName"], "span");
        assert_eq!(children[1]["properties"]["className"][1], "math-inline");
        assert_eq!(children[1]["children"][0]["value"], "a+b");
        assert_eq!(children[2]["value"], " more");
    }
}
