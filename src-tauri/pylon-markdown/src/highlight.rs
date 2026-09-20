//! syntect（fancy-regex 后端，**无 onig C 依赖**）整块高亮（纯内层，宿主可测）。
//!
//! 边界约定（spec 边界约定 3，用户裁决）：**整块进 / 整块（或行数组）出**。
//! 逐行过界 = 每块几百次小调用，禁止——本模块对外只暴露 [`highlight_block`]：
//! 一次调用吃下整块代码，一次调用吐出全部行的 span 数组。跨语言契约只发生
//! 这一次，行数组在 Rust 侧切好再过界。
//!
//! 与 TS 基线（starry-night）的形状对齐：starry-night 产 hast（`pl-*` class 的
//! span 嵌套），本模块产 **scope 栈 + 主题样式** 的扁平 span。两者不是同一种
//! 语义（scope 名 ≠ github css class），逐字节相等不可能；parity 目标是
//! 「token span 形状对齐 + 差异清单过审」，差异明细见 `parity/` 工具产出。
//!
//! 为什么是 `fancy-regex`：wasm 目标编译不了 onig（C 依赖），syntect 必须以
//! `default-features = false` + `default-fancy` 引入——这条写进 Cargo.toml 注释。

use std::sync::OnceLock;

use syntect::highlighting::{Highlighter, ThemeSet};
use syntect::parsing::{ParseState, ScopeStack, SyntaxSet};
use syntect::util::LinesWithEndings;

/// 单个高亮 span：触发时的 scope 栈（外层在前）+ 主题样式 + 原文切片。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct HighlightSpan {
    /// scope 栈逐级全名，如 `["source.rust", "keyword.control.rust"]`。
    /// 与 starry-night 的 TextMate scope 同一语义体系（starry 按 scope 匹配
    /// css 选择器换成 `pl-*` class；映射层归属是差异清单里的裁决点）。
    #[serde(rename = "scopeStack")]
    pub scope_stack: Vec<String>,
    /// 主题前景色（`#rrggbb`）。starry-night 不产颜色（颜色在 CSS 里），
    /// 此字段供行数组消费方直接用，也是与 `pl-*` class 的形状差所在。
    #[serde(rename = "fgHex")]
    pub fg_hex: Option<String>,
    /// 字体修饰：`BOLD` / `ITALIC` / `UNDERLINE` 的子集。
    #[serde(rename = "fontStyle")]
    pub font_style: Vec<String>,
    pub text: String,
}

/// 一行高亮结果。块 → 行数组是出口形状（边界约定：行数组出）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct HighlightedLine {
    pub spans: Vec<HighlightSpan>,
}

/// 语言别名 → TextMate scope。与 TS 基线 `codeHighlight.ts` 的
/// `LANGUAGE_SCOPES` 同表——两边各写一份是暂时的（TS 侧退役后此处即单源）。
pub fn scope_for_language(language: &str) -> Option<&'static str> {
    const LANGUAGE_SCOPES: &[(&str, &str)] = &[
        ("js", "source.js"),
        ("javascript", "source.js"),
        ("jsx", "source.js"),
        ("ts", "source.ts"),
        ("typescript", "source.ts"),
        ("tsx", "source.tsx"),
        ("py", "source.python"),
        ("python", "source.python"),
        ("rs", "source.rust"),
        ("rust", "source.rust"),
        ("go", "source.go"),
        ("java", "source.java"),
        ("c", "source.c"),
        ("cpp", "source.c++"),
        ("cxx", "source.c++"),
        ("css", "source.css"),
        ("json", "source.json"),
        ("yaml", "source.yaml"),
        ("yml", "source.yaml"),
        ("sh", "source.shell"),
        ("shell", "source.shell"),
        ("bash", "source.shell"),
        ("html", "text.html.basic"),
        ("markup", "text.html.basic"),
    ];
    let lowered = language.to_lowercase();
    LANGUAGE_SCOPES
        .iter()
        .find(|(alias, _)| *alias == lowered)
        .map(|(_, scope)| *scope)
}

static SYNTAX_SET: OnceLock<SyntaxSet> = OnceLock::new();
static THEME_SET: OnceLock<ThemeSet> = OnceLock::new();

fn syntax_set() -> &'static SyntaxSet {
    SYNTAX_SET.get_or_init(SyntaxSet::load_defaults_newlines)
}

fn theme_set() -> &'static ThemeSet {
    THEME_SET.get_or_init(ThemeSet::load_defaults)
}

/// 整块高亮：`code` 是**完整代码块正文**（不含围栏行），`language` 是围栏信息串
/// 首词。语言未知时返回 `Ok(None)`（与 TS 基线 `highlightCode` 返回 null 同语义）。
///
/// 失败只可能是语法引擎内部错误（fancy-regex 回溯异常等），按 `Err(String)` 上抛。
pub fn highlight_block(code: &str, language: &str) -> Result<Option<Vec<HighlightedLine>>, String> {
    let Some(scope_name) = scope_for_language(language) else {
        return Ok(None);
    };
    let syntax_set = syntax_set();
    let Some(syntax) = syntax_set.find_syntax_by_scope(
        scope_name
            .parse()
            .map_err(|e| format!("scope 解析失败: {e}"))?,
    ) else {
        // syntect 默认语法集没有对应语法（如 tsx）——与 TS 基线的「未知语言返回
        // null」不同：这里语言别名认识、语法包缺失，逐条记进差异清单。
        return Ok(None);
    };

    let theme_set = theme_set();
    let theme = theme_set
        .themes
        .get("InspiredGitHub")
        .ok_or_else(|| "默认主题缺失".to_string())?;
    let highlighter = Highlighter::new(theme);

    let mut parse_state = ParseState::new(syntax);
    let mut scope_stack = ScopeStack::new();
    let mut lines = Vec::new();

    for line in LinesWithEndings::from(code) {
        // syntect 5.x：parse_line 产 `(字节位置, ScopeStackOp)` 列表，位置即该 op
        // 生效点。官方 RangedHighlightIterator 的区间规则是：**先**用「当前栈」
        // 样式化 [pos, end)，**再**应用 op、推进 pos——这里照抄该语义，只是把
        // 「主题样式」换成「scope 栈 + 主题样式」一起带出去。
        let changes = parse_state
            .parse_line(line, syntax_set)
            .map_err(|error| format!("语法解析失败: {error}"))?;
        let mut spans = Vec::new();
        let mut pos = 0usize;
        for (end, command) in &changes {
            let end = (*end).min(line.len());
            if end > pos {
                spans.push(make_span(&scope_stack, &highlighter, &line[pos..end]));
            }
            // apply 的 Err 只在 op 与栈不一致时出现（语法 dump 损坏级别的问题），
            // 与 parse_line 的失败同级，按同一错误通道上抛。
            scope_stack
                .apply(command)
                .map_err(|error| format!("scope 栈应用失败: {error}"))?;
            pos = end;
        }
        if line.len() > pos {
            spans.push(make_span(&scope_stack, &highlighter, &line[pos..]));
        }
        lines.push(HighlightedLine { spans });
    }

    Ok(Some(lines))
}

fn make_span(scope_stack: &ScopeStack, highlighter: &Highlighter<'_>, text: &str) -> HighlightSpan {
    let styled = highlighter.style_for_stack(scope_stack.as_slice());
    HighlightSpan {
        scope_stack: scope_stack
            .as_slice()
            .iter()
            .map(|scope| scope.to_string())
            .collect(),
        fg_hex: Some(format!(
            "#{:02x}{:02x}{:02x}",
            styled.foreground.r, styled.foreground.g, styled.foreground.b
        )),
        font_style: font_style_flags(styled.font_style),
        text: text.to_string(),
    }
}

fn font_style_flags(font_style: syntect::highlighting::FontStyle) -> Vec<String> {
    let mut flags = Vec::new();
    if font_style.contains(syntect::highlighting::FontStyle::BOLD) {
        flags.push("BOLD".to_string());
    }
    if font_style.contains(syntect::highlighting::FontStyle::UNDERLINE) {
        flags.push("UNDERLINE".to_string());
    }
    if font_style.contains(syntect::highlighting::FontStyle::ITALIC) {
        flags.push("ITALIC".to_string());
    }
    flags
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 语言映射与 TS 基线同表（抽查四个方位：别名、大小写归一、未知、markup）。
    #[test]
    fn scope_mapping_matches_ts_baseline() {
        assert_eq!(scope_for_language("typescript"), Some("source.ts"));
        assert_eq!(scope_for_language("rs"), Some("source.rust"));
        assert_eq!(scope_for_language("CPP"), Some("source.c++"));
        assert_eq!(scope_for_language("markup"), Some("text.html.basic"));
        assert_eq!(scope_for_language("nope"), None);
    }

    /// 整块进 / 行数组出：一次调用产出行数组；行数与输入行数一致。
    #[test]
    fn whole_block_in_lines_out() {
        let code = "fn main() {\n    let x: u32 = 1;\n}\n";
        let lines = highlight_block(code, "rust").unwrap().expect("rust 有语法");
        assert_eq!(lines.len(), 3, "三行输入产三行输出（结尾换行不产空行）");
        let joined: String = lines
            .iter()
            .flat_map(|l| &l.spans)
            .map(|s| s.text.clone())
            .collect();
        assert_eq!(joined, code, "span 文本拼回应逐字节等于输入");
    }

    /// 关键字确实被识别出 scope（不是全文单一 plaintext span）。
    #[test]
    fn recognizes_keywords() {
        let lines = highlight_block("fn main() {}\n", "rust").unwrap().unwrap();
        let scopes: Vec<String> = lines
            .iter()
            .flat_map(|l| &l.spans)
            .flat_map(|s| &s.scope_stack)
            .cloned()
            .collect();
        assert!(
            scopes
                .iter()
                .any(|s| s.contains("keyword") || s.contains("storage")),
            "应存在 keyword/storage 类 scope，实际: {scopes:?}"
        );
    }

    /// 未知语言 → None（与 TS 返回 null 同语义），且不因缺语法包报错。
    #[test]
    fn unknown_language_is_none() {
        assert!(highlight_block("x", "nope").unwrap().is_none());
    }

    /// tsx：别名认识但 syntect 默认语法集缺语法 → None（差异清单条目，不 panic）。
    #[test]
    fn tsx_missing_in_syntect_defaults_is_none() {
        assert!(highlight_block("const a = 1;\n", "tsx").unwrap().is_none());
    }

    /// syntect 默认语法集对 TS 基线 14 个 scope 的覆盖面——这是「语言别名认识但
    /// 语法包缺失返回 null」差异清单的事实依据。打印全表便于复核（--nocapture）。
    #[test]
    fn syntect_default_scope_coverage() {
        let syntax_set = syntax_set();
        let scopes = [
            "source.js",
            "source.ts",
            "source.tsx",
            "source.python",
            "source.rust",
            "source.go",
            "source.java",
            "source.c",
            "source.c++",
            "source.css",
            "source.json",
            "source.yaml",
            "source.shell",
            "text.html.basic",
        ];
        for scope in scopes {
            let found = syntax_set
                .find_syntax_by_scope(scope.parse().expect("测试内 scope 字面量必然合法"))
                .is_some();
            println!("{scope}: {}", if found { "有" } else { "缺" });
        }
    }
}
