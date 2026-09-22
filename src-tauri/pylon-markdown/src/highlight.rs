//! 整块高亮（syntect 词法引擎 + starry-night 类名主题层，纯内层，宿主可测）。
//!
//! 边界约定（spec 边界约定 3，用户裁决）：**整块进 / 整块（或行数组）出**。
//! 逐行过界 = 每块几百次小调用，禁止——本模块对外只暴露 [`highlight_block`]：
//! 一次调用吃下整块代码，一次调用吐出全部行的 span 数组。跨语言契约只发生
//! 这一次，行数组在 Rust 侧切好再过界。
//!
//! ## 与 TS 基线（starry-night）的对齐方式（issue #220 差异项 D2/D5 的收口）
//!
//! TS 侧产出 github css 类名（`pl-k` 等），来源是三层：
//! 1. **TextMate 语法**：starry-night 自带一套 tmLanguage（VSCode 分发）；
//! 2. **主题匹配**：vscode-textmate 按栈顶 scope 定位 trie、取最高特异度规则；
//! 3. **类名解码**：主题把类名编码成颜色序号，token 解码回 `pl-*`。
//!
//! 本模块逐一对应：语法用 **同一份** tmLanguage（`assets/grammars/`，由
//! `gen/generate-assets.mjs` 从 node_modules 原样导出，经 [`crate::tm_language`]
//! 转成 syntect 可加载的 sublime-syntax——因此不再用 syntect 默认语法集，旧
//! D3「缺 ts/tsx」与 D5「边界粒度不一致」一起收口）；主题匹配在
//! [`crate::theme`] 按 vscode-textmate 算法移植；类名解码同样照搬。
//!
//! ## 输出形状
//!
//! 每行 [`HighlightedLine`]（**不含行尾换行**——换行由消费方按行拼），span 是
//! `classes`（hast 类名链，外→内）+ `text`。同链相邻 span 已按 starry 的
//! `delve`/`appendText` 规则就地合并；跨行的**无类文本**合并归一化在 parity
//! 工具（`parity/diff.mjs`、vitest 门禁）里做——行数组形状下无法表达跨行合并。
//!
//! ## 已知残差（详见 parity-report 的差异清单）
//!
//! - fancy-regex 无 `\G`（「扫描起点」锚），转换层删除该锚——影响 CSS @规则
//!   续匹配等连续锚定场景；
//! - capture 级子 patterns（sublime-syntax 无法表达）被丢弃；
//! - begin/end 匹配段自身的样式：syntect 的 meta scope 时机与 vscode-textmate
//!   有微妙出入（如 begin 引号是否带块级 meta_scope）。
//! 这些是 syntect 引擎与 vscode-textmate 的实现性差异，逐条以 corpus 差分过审。

use std::sync::{LazyLock, OnceLock};

use syntect::parsing::{ParseState, ScopeStack, SyntaxSet};

use crate::theme::StarryTheme;

/// 单个高亮 span：hast 类名链（外→内，如 `["pl-s", "pl-s1"]`）+ 原文切片。
///
/// 与 TS 基线 hast 树的叶子一一对应：类名链即 span 嵌套路径；无类文本的
/// `classes` 为空数组。旧形状（scopeStack + fgHex + fontStyle）已废弃——
/// 那是「scope 栈 + 主题颜色」体系，与 github 类名体系不是同一语义。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct HighlightSpan {
    pub classes: Vec<String>,
    pub text: String,
}

/// 一行高亮结果（**不含行尾换行**，见模块注释「输出形状」）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct HighlightedLine {
    pub spans: Vec<HighlightSpan>,
}

/// 语言别名 → TextMate scope。与 TS 的 `codeHighlight.ts` 的 `LANGUAGE_SCOPES` 同表。
///
/// **同表两份是既成事实，且不宜用「TS 侧改调 wasm」来收敛**：实测（issue #233 的对照，三次运行
/// 17.99/18.14/18.08）经 wasm 出口查一次表比 TS 侧普通对象查表**慢约 18×**——每调用一次要过边界
/// 并把 `Option<String>` 编成 JS 串，而语言门在 `codeHighlight.ts:89` 是逐代码块调用的同步门。
/// 该 wasm 壳已按此删除（#236）。若仍要单源，正路是**代码生成**（先例：
/// `scripts/generate-canonical-event-types.mjs` 从 `pylon-canonical-types` 生成 TS 词表），
/// 本函数服务 `highlight_block` 的内部映射，保持 Rust 侧自持。
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

/// vendored 语法资产（scope → tmLanguage JSON）。文件由 `gen/generate-assets.mjs`
/// 生成并连同来源/许可证（assets/grammars/SOURCES.md）一起入库，勿手改。
const GRAMMAR_ASSETS: &[(&str, &str)] = &[
    (
        "source.js",
        include_str!("../assets/grammars/source.js.json"),
    ),
    (
        "source.ts",
        include_str!("../assets/grammars/source.ts.json"),
    ),
    (
        "source.tsx",
        include_str!("../assets/grammars/source.tsx.json"),
    ),
    (
        "source.python",
        include_str!("../assets/grammars/source.python.json"),
    ),
    (
        "source.rust",
        include_str!("../assets/grammars/source.rust.json"),
    ),
    (
        "source.go",
        include_str!("../assets/grammars/source.go.json"),
    ),
    (
        "source.java",
        include_str!("../assets/grammars/source.java.json"),
    ),
    ("source.c", include_str!("../assets/grammars/source.c.json")),
    (
        "source.c++",
        include_str!("../assets/grammars/source.c++.json"),
    ),
    (
        "source.css",
        include_str!("../assets/grammars/source.css.json"),
    ),
    (
        "source.json",
        include_str!("../assets/grammars/source.json.json"),
    ),
    (
        "source.yaml",
        include_str!("../assets/grammars/source.yaml.json"),
    ),
    (
        "source.shell",
        include_str!("../assets/grammars/source.shell.json"),
    ),
    (
        "text.html.basic",
        include_str!("../assets/grammars/text.html.basic.json"),
    ),
];

/// starry 类名主题（scope 选择器 → pl-* 类名的 textmate 编码）。
static THEME: LazyLock<StarryTheme> = LazyLock::new(|| {
    StarryTheme::from_asset(include_str!("../assets/starry-theme.json"))
        .expect("starry-theme.json 是生成资产，构建失败说明资产与代码脱节")
});

/// 每个语法一个槽位：首次用到该语言时才把 tmLanguage 转成 SyntaxSet
/// （ts/tsx 的 JSON 各 ~210KB，全量预构建会让首个调用白付 14 份解析成本）。
static ENGINE_SLOTS: LazyLock<Vec<OnceLock<SyntaxSet>>> =
    LazyLock::new(|| GRAMMAR_ASSETS.iter().map(|_| OnceLock::new()).collect());

/// 按语法包名（TextMate scope）取该语言的**独立** SyntaxSet。
///
/// 为什么每个语法独立成集、且缺依赖语法不报错：TS 基线是
/// `createStarryNight([单个语法])`——依赖语法（如 source.c++ 引用的 source.c）
/// 未注册时 include 解析为空，代码几乎不分词。Rust 侧同样按「单语法集」构建，
/// 行为才能逐 token 对齐（这正是 cpp 在 TS 侧整块不分词的机制，见差异清单）。
fn engine_for_scope(scope: &str) -> Option<&'static SyntaxSet> {
    let index = GRAMMAR_ASSETS.iter().position(|(name, _)| *name == scope)?;
    let slot = ENGINE_SLOTS.get(index)?;
    Some(slot.get_or_init(|| {
        let (_, json) = GRAMMAR_ASSETS[index];
        build_engine(scope, json).expect("vendored 语法资产必须可转换可加载（有单测守护）")
    }))
}

/// tmLanguage JSON → 独立 SyntaxSet（转换 + 加载一步完成）。
fn build_engine(scope: &str, json: &str) -> Result<SyntaxSet, String> {
    let grammar: serde_json::Value = serde_json::from_str(json)
        .map_err(|error| format!("{scope}: 语法 JSON 解析失败: {error}"))?;
    let converted = crate::tm_language::tm_language_to_sublime_syntax(&grammar)
        .map_err(|error| format!("{scope}: 语法转换失败: {error}"))?;
    // 第二个参数 = 行是否含结尾换行：本模块按「不含换行」的行喂 parse_line。
    let definition =
        syntect::parsing::SyntaxDefinition::load_from_str(&converted.yaml, false, Some(scope))
            .map_err(|error| format!("{scope}: sublime-syntax 加载失败: {error}"))?;
    let mut builder = syntect::parsing::SyntaxSetBuilder::new();
    builder.add(definition);
    Ok(builder.build())
}

/// 整块高亮：`code` 是**完整代码块正文**（不含围栏行），`language` 是围栏信息串
/// 首词。语言未知时返回 `Ok(None)`（与 TS 基线 `highlightCode` 返回 null 同语义）。
///
/// 失败只可能是语法引擎内部错误（fancy-regex 回溯异常等），按 `Err(String)` 上抛。
pub fn highlight_block(code: &str, language: &str) -> Result<Option<Vec<HighlightedLine>>, String> {
    let Some(scope_name) = scope_for_language(language) else {
        return Ok(None);
    };
    let Some(syntax_set) = engine_for_scope(scope_name) else {
        return Ok(None);
    };
    let Some(syntax) = syntax_set.find_syntax_by_scope(
        scope_name
            .parse()
            .map_err(|e| format!("scope 解析失败: {e}"))?,
    ) else {
        // 语言别名认识、语法集里却没有——上面按资产表构建，正常不会走到；
        // 与「未知语言返回 null」同语义返回 None，不 panic。
        return Ok(None);
    };
    let theme = &*THEME;

    let mut parse_state = ParseState::new(syntax);
    // scope 栈与 ParseState 一样**跨行持久**：parse_line 返回的 ops 是「相对当前
    // 栈」的增量，每行重置会让第 2 行起全部失去上层 scope（实测 go/sh 翻车点）。
    let mut scope_stack = ScopeStack::new();
    let mut lines = Vec::new();

    for raw_line in split_lines(code) {
        // 每行**不含**换行地喂引擎（starry 同样把换行从 tokenizeLine 的输入里
        // 剥出去、单独当无类文本处理）。行数组出界时不携带换行，消费方按行拼。
        let changes = parse_state
            .parse_line(&raw_line, syntax_set)
            .map_err(|error| format!("语法解析失败: {error}"))?;
        let mut spans: Vec<HighlightSpan> = Vec::new();
        let mut pos = 0usize;
        for (end, command) in &changes {
            let end = (*end).min(raw_line.len());
            if end > pos {
                push_span(&scope_stack, theme, &raw_line[pos..end], &mut spans);
            }
            // apply 的 Err 只在 op 与栈不一致时出现（语法 dump 损坏级别的问题），
            // 与 parse_line 的失败同级，按同一错误通道上抛。
            scope_stack
                .apply(command)
                .map_err(|error| format!("scope 栈应用失败: {error}"))?;
            pos = end;
        }
        if raw_line.len() > pos {
            push_span(&scope_stack, theme, &raw_line[pos..], &mut spans);
        }
        lines.push(HighlightedLine { spans });
    }

    Ok(Some(lines))
}

/// 按换行切分（`code.split_inclusive` 的语义），返回**剥掉行尾换行**的行内容。
/// `\r\n` 与 `\n` 都处理；孤立的 `\r`（老 Mac 换行）不作为分隔——与 syntect 的
/// 行迭代一致，starry 会切（corpus 无此输入，残差记入差异清单）。
fn split_lines(code: &str) -> Vec<&str> {
    code.split_inclusive('\n')
        .map(|line| {
            let line = line.strip_suffix('\n').unwrap_or(line);
            line.strip_suffix('\r').unwrap_or(line)
        })
        .collect()
}

/// 由 scope 栈求类名链并按 starry 的合并规则追加 span（同链相邻 span 合并，
/// 对应 hast 构建里 `delveIfClassName` 复用尾元素的语义）。
fn push_span(
    scope_stack: &ScopeStack,
    theme: &StarryTheme,
    text: &str,
    spans: &mut Vec<HighlightSpan>,
) {
    if text.is_empty() {
        return;
    }
    let scopes: Vec<String> = scope_stack
        .as_slice()
        .iter()
        .map(|s| s.to_string())
        .collect();
    let scope_refs: Vec<&str> = scopes.iter().map(String::as_str).collect();
    let style = theme.match_stack(&scope_refs);
    let classes = style.class_chain(theme);
    if let Some(last) = spans.last_mut() {
        if last.classes == classes {
            last.text.push_str(text);
            return;
        }
    }
    spans.push(HighlightSpan {
        classes,
        text: text.to_string(),
    });
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

    /// 整块进 / 行数组出：一次调用产出行数组；行数与输入行数一致；
    /// 行 span 文本拼回**不含换行的行内容**。
    #[test]
    fn whole_block_in_lines_out() {
        let code = "fn main() {\n    let x: u32 = 1; // answer\n    println!(\"{}\", x);\n}\n";
        let lines = highlight_block(code, "rust").unwrap().expect("rust 有语法");
        assert_eq!(lines.len(), 4, "四行输入产四行输出");
        for (line, raw) in lines.iter().zip(code.split_inclusive('\n')) {
            let joined: String = line.spans.iter().map(|s| s.text.as_str()).collect();
            assert_eq!(joined, raw.strip_suffix('\n').expect("输入以换行结尾"));
        }
    }

    /// 未知语言 → None（与 TS 返回 null 同语义），且不因缺语法包报错。
    #[test]
    fn unknown_language_is_none() {
        assert!(highlight_block("x", "nope").unwrap().is_none());
    }

    /// 全部 14 个 vendored 语法可转换、可加载、可解析（资产回归门）。
    /// 转换损失除过审项外必须为零，正则全部可编译（load_from_str 内建校验）。
    /// PylonGrammarProbe 环境变量可过滤单个语法（诊断用）。
    #[test]
    fn all_vendored_grammars_load_cleanly() {
        let filter = std::env::var("PylonGrammarProbe").unwrap_or_default();
        for (scope, json) in GRAMMAR_ASSETS {
            if !filter.is_empty() && *scope != filter {
                continue;
            }
            let grammar: serde_json::Value =
                serde_json::from_str(json).unwrap_or_else(|e| panic!("{scope}: {e}"));
            let converted = crate::tm_language::tm_language_to_sublime_syntax(&grammar)
                .unwrap_or_else(|e| panic!("{scope}: {e}"));
            assert!(
                converted.report.unexpected_losses().is_empty(),
                "{scope}: {:?}",
                converted.report
            );
            let definition = syntect::parsing::SyntaxDefinition::load_from_str(
                &converted.yaml,
                false,
                Some(scope),
            )
            .unwrap_or_else(|e| panic!("{scope}: 加载失败 {e}（报告: {:?}）", converted.report));
            assert_eq!(definition.scope.to_string(), *scope);
            let mut builder = syntect::parsing::SyntaxSetBuilder::new();
            builder.add(definition);
            let set = builder.build();
            // 加载后走一遍真实解析，抓「惰性编译才爆」的正则/环问题。
            // PylonProbeInput 可自定义输入（诊断用）；输入不得含换行。
            let probe = std::env::var("PylonProbeInput").unwrap_or_else(|_| {
                "fn main() { const a: x = 1; } // c <a b=\"c\">{d: e}</a>".into()
            });
            let mut state =
                ParseState::new(set.find_syntax_by_scope(scope.parse().unwrap()).unwrap());
            state
                .parse_line(&probe, &set)
                .unwrap_or_else(|e| panic!("{scope}: {e}"));
        }
    }

    /// ts/tsx 不再缺失（旧 D3 差异项收口的直接证据）。
    #[test]
    fn ts_and_tsx_available() {
        assert!(highlight_block("const a: number = 42;\n", "ts")
            .unwrap()
            .is_some());
        assert!(highlight_block("const a = <div />;\n", "tsx")
            .unwrap()
            .is_some());
    }

    /// 产出 span 的类名落在 github `pl-*` 体系内（D2 收口的形状证据）。
    #[test]
    fn spans_carry_github_class_names() {
        let lines = highlight_block("const answer = 42;\n", "ts")
            .unwrap()
            .unwrap();
        let classes: Vec<&str> = lines
            .iter()
            .flat_map(|l| &l.spans)
            .flat_map(|s| s.classes.iter().map(String::as_str))
            .collect();
        assert!(
            classes.iter().any(|c| c.starts_with("pl-")),
            "应存在 pl-* 类名，实际: {classes:?}"
        );
    }
}
