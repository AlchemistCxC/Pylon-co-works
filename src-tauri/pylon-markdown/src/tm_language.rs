//! tmLanguage（TextMate JSON 语法）→ syntect（sublime-syntax YAML）的**机械转换器**。
//!
//! 为什么存在：parity 比对面是 TS 基线 starry-night，它带的语法是 **TextMate JSON**
//! （`assets/grammars/*.json`，由 `gen/generate-assets.mjs` 从 node_modules 原样导出）。
//! syntect 5 只吃 sublime-syntax（YAML），且本 crate 面向 wasm 不能引入 onig——
//! 因此把 JSON 语法在**内存里**转成 sublime-syntax 文本再喂
//! [`syntect::parsing::SyntaxDefinition::load_from_str`]，同一份语法原文驱动两侧。
//!
//! 转换只做结构映射（patterns → contexts，begin/end → push/pop），**不改语法语义**：
//! - `{include: '#foo'}` → `include: foo`；`$self` / `$base` → `include: main`
//! - `{begin, end}` → `push: <匿名上下文>`，pop 规则的**位置**表达
//!   textmate 的 `applyEndPatternLast`（缺省时 end 优先 → pop 放最前）
//! - `name` / `contentName` → `meta_scope` / `meta_content_scope`
//! - 正则归一化（逐条计数进 [`ConversionReport`]，损失可审计）：
//!   - `(?#…)` 内联注释剥离（oniguruma 专属；rust 正则不识别）
//!   - `\h` → `[0-9A-Fa-f]`（oniguruma 十六进制数字类）
//!   - `\G` → 删除（fancy-regex 无「扫描起点」锚；语义损失见报告）。
//!     这是转换层**唯一有语义损失**的归一化：受影响的是续匹配锚定
//!     （CSS @规则续匹配等），简单代码块不触发。
//!
//! 与 TS 基线「单语法注册」行为对齐的关键决策：textmate 的 `include` 指向**其它
//! 语法**（非 `#repo`、非 `$self`/`$base`）时直接**丢弃**——TS 侧
//! `createStarryNight([单个语法])` 同样解析不到未注册语法（issue #220 差异清单
//! 里 cpp 在 TS 侧整块不分词正是这个机制）。两侧「缺依赖语法」的行为由此对称。
//!
//! 已知结构性损失（syntect 表达不了，只能在报告里记账）：
//! - **capture 级子 patterns**（`captures: {1: {name, patterns}}` 里的 patterns）——
//!   sublime-syntax 无法给捕获组挂子规则；丢弃后保留 name。
//!
//! YAML 细节：标量一律走双引号（[`quote_yaml`]），反斜杠/引号/控制符全转义，
//! 字面量语义不因 YAML 解析漂移。

use std::collections::BTreeMap;

use serde_json::Value;

/// 转换损失/归一化的审计记录——测试断言它，报告引用它，不许静默丢信息。
#[derive(Debug, Default, Clone, PartialEq, serde::Serialize)]
pub struct ConversionReport {
    /// 丢弃的「外部语法 include」（对应 TS 侧单语法注册解析不到的行为）。
    pub dropped_external_includes: usize,
    /// 丢弃的 capture 级子 patterns（syntect 无法表达，见 push_captures）。
    pub dropped_capture_subpatterns: usize,
    /// 退化为单一 scope 的 capture 级子 patterns 条数（可安全退化的部分）。
    pub flattened_capture_subpatterns: usize,
    /// `(?#…)` 内联注释剥离次数。
    pub stripped_inline_comments: usize,
    /// `\h` → `[0-9A-Fa-f]` 归一化次数。
    pub normalized_hex_escapes: usize,
    /// 删除的 `\G` 锚个数（唯一语义损失项，见模块注释）。
    pub removed_go_anchors: usize,
    /// 展开的 `\g<name>` 子程序调用个数（oniguruma 专属，fancy-regex 未实现）。
    pub expanded_subroutine_calls: usize,
    /// 丢弃的 `while` 规则数（本批 14 份语法实测为 0；出现即须人工复核）。
    pub dropped_while_rules: usize,
    /// 因构成 eager include 环而被切断的 `$self`/`$base` → main 引用个数。
    /// vscode-textmate 在编译期用 seen-cache 切断重复拼接（环自然断开），
    /// syntect 的 include 是无环检的纯拼接，必须显式断边否则解析器死循环。
    pub cut_self_include_cycles: usize,
    /// 解开的「推进即弹栈」块（`end: '(?!\G)'` 习惯用法）个数，见 convert_begin_end。
    pub unwrapped_auto_pop_blocks: usize,
}

impl ConversionReport {
    /// 除已过审项（`\G`、capture 子 patterns）外，其余损失必须为零——这是
    /// 「机械转换不改语义」的回归门。新增语法包时由此拦截意外损失。
    pub fn unexpected_losses(&self) -> Vec<&'static str> {
        let mut issues = Vec::new();
        if self.dropped_while_rules > 0 {
            issues.push("dropped_while_rules > 0：出现 while 规则，转换器未实现");
        }
        issues
    }
}

/// 转换产物：sublime-syntax YAML 文本（喂 `load_from_str`）+ 审计报告。
pub struct Converted {
    pub yaml: String,
    pub report: ConversionReport,
}

/// 转换入口。`grammar` 是 tmLanguage JSON（`assets/grammars/*.json` 的解析结果）。
pub fn tm_language_to_sublime_syntax(grammar: &Value) -> Result<Converted, String> {
    let scope_name = grammar["scopeName"]
        .as_str()
        .ok_or("tmLanguage 缺 scopeName")?
        .to_string();
    let mut cx = Converter {
        report: ConversionReport::default(),
        anon_counter: 0,
        self_scope: scope_name.clone(),
        include_edges: Vec::new(),
    };

    // 语法级字段：name 用 names[0]（starry 语法的惯用字段）；扩展名去掉前导点。
    let mut top = String::new();
    if let Some(first) = grammar["names"][0].as_str() {
        top.push_str(&format!("name: {}\n", quote_yaml(first)));
    }
    top.push_str(&format!("scope: {}\n", quote_yaml(&scope_name)));
    if let Some(exts) = grammar["extensions"].as_array() {
        let exts: Vec<String> = exts
            .iter()
            .filter_map(|v| v.as_str())
            .map(|s| s.strip_prefix('.').unwrap_or(s).to_string())
            .collect();
        if !exts.is_empty() {
            let list: Vec<String> = exts.iter().map(|s| quote_yaml(s)).collect();
            top.push_str(&format!("file_extensions: [{}]\n", list.join(", ")));
        }
    }

    // repository 键 → 上下文名的映射先建齐（`#foo` → `foo`；与 syntect 内部
    // 保留名冲突时加前缀），根 patterns 与 repository 体共用这张表。
    let mut renames: BTreeMap<String, String> = BTreeMap::new();
    if let Some(repository) = grammar["repository"].as_object() {
        for key in repository.keys() {
            let target = if matches!(key.as_str(), "main" | "prototype" | "__start" | "__main") {
                format!("repo_{key}")
            } else {
                key.clone()
            };
            renames.insert(format!("#{key}"), target);
        }
    }

    // 逐个转换；BTreeMap 保证上下文输出顺序稳定（diff 友好）。
    let mut contexts: BTreeMap<String, Vec<String>> = BTreeMap::new();
    if let Some(repository) = grammar["repository"].as_object() {
        for (key, value) in repository {
            let target = renames
                .get(&format!("#{key}"))
                .expect("映射在上面循环里已建齐")
                .clone();
            let lines = cx.convert_rule_list(value, &renames, &mut contexts, &target)?;
            contexts.insert(target, lines);
        }
    }

    // 根 patterns → main 上下文（syntect 的 add_initial_contexts 会自动把
    // scopeName 挂到 main/__start 的 meta_content_scope 上，无需手写）。
    let root_patterns = grammar["patterns"]
        .as_array()
        .ok_or("tmLanguage 缺 patterns")?;
    let main_lines = cx.convert_patterns(root_patterns, &renames, &mut contexts, "main")?;
    contexts.insert("main".to_string(), main_lines);

    // 切断自引用 include 环（见 cut_self_include_cycles 的注释）。
    cut_self_include_cycles(&mut contexts, &cx.include_edges, &mut cx.report);

    let mut yaml = top;
    yaml.push_str("contexts:\n");
    for (name, lines) in &contexts {
        yaml.push_str(&format!("  {}:\n", quote_yaml(name)));
        if lines.is_empty() {
            yaml.push_str("    []\n");
            continue;
        }
        for line in lines {
            yaml.push_str(line);
        }
    }
    Ok(Converted {
        yaml,
        report: cx.report,
    })
}

struct Converter {
    report: ConversionReport,
    anon_counter: usize,
    self_scope: String,
    /// include 边（from 上下文 → to 上下文），用于环检测。
    /// `is_main_edge` = 该边由 `$self`/`$base`/自 scope 引用产生（目标是 main）。
    include_edges: Vec<(String, String, bool)>,
}

impl Converter {
    /// patterns 数组 → YAML 行。`contexts` 用于登记 begin/end 产生的匿名上下文；
    /// `owner` 是这些行所属的上下文名（include 边的起点）。
    fn convert_patterns(
        &mut self,
        patterns: &[Value],
        renames: &BTreeMap<String, String>,
        contexts: &mut BTreeMap<String, Vec<String>>,
        owner: &str,
    ) -> Result<Vec<String>, String> {
        let mut lines = Vec::new();
        for rule in patterns {
            if !rule.is_object() {
                continue; // 非对象规则（注释残留等）安全跳过
            }
            self.convert_rule(rule, renames, contexts, owner, &mut lines)?;
        }
        Ok(lines)
    }

    /// repository 值的三种形态统一入口：直接数组 / 单条规则 / `{patterns: [...]}`。
    /// 注意顺序：begin/match 规则对象**也可能带 `patterns` 子键**（begin/end 的
    /// 子规则），必须先按单规则处理，否则 begin/end 被丢、只剩子规则——那会在
    /// include 链上造出 `main → repo → main` 的自包含环（json 语法的实测翻车点）。
    fn convert_rule_list(
        &mut self,
        value: &Value,
        renames: &BTreeMap<String, String>,
        contexts: &mut BTreeMap<String, Vec<String>>,
        owner: &str,
    ) -> Result<Vec<String>, String> {
        if let Some(list) = value.as_array() {
            return self.convert_patterns(list, renames, contexts, owner);
        }
        if value.is_object() && (value["begin"].is_string() || value["match"].is_string()) {
            let mut lines = Vec::new();
            self.convert_rule(value, renames, contexts, owner, &mut lines)?;
            return Ok(lines);
        }
        if let Some(list) = value["patterns"].as_array() {
            return self.convert_patterns(list, renames, contexts, owner);
        }
        Ok(Vec::new())
    }

    fn convert_rule(
        &mut self,
        rule: &Value,
        renames: &BTreeMap<String, String>,
        contexts: &mut BTreeMap<String, Vec<String>>,
        owner: &str,
        lines: &mut Vec<String>,
    ) -> Result<(), String> {
        if let Some(include) = rule["include"].as_str() {
            if let Some(target) = self.resolve_include(include, renames) {
                let is_main_edge = target == "main";
                self.include_edges
                    .push((owner.to_string(), target.clone(), is_main_edge));
                lines.push(format!("    - include: {}\n", quote_yaml(&target)));
            }
            // resolve 返回 None = 外部语法引用被丢弃（对齐 TS 单语法注册）。
            return Ok(());
        }
        if rule["while"].is_string() {
            self.report.dropped_while_rules += 1;
            return Ok(());
        }
        if let Some(match_re) = rule["match"].as_str() {
            let normalized = normalize_regex(match_re, &mut self.report);
            lines.push(format!("    - match: {}\n", quote_yaml(&normalized)));
            push_rule_styles(rule, &mut self.report, lines);
            return Ok(());
        }
        if let Some(begin_re) = rule["begin"].as_str() {
            self.convert_begin_end(rule, begin_re, renames, contexts, owner, lines);
            return Ok(());
        }
        // 其余形态（空规则等）忽略。
        Ok(())
    }

    /// textmate include → sublime-syntax 上下文名（模块注释「单语法注册」）。
    /// 返回 None 表示该 include 应被丢弃（外部语法引用）。
    fn resolve_include(
        &mut self,
        include: &str,
        renames: &BTreeMap<String, String>,
    ) -> Option<String> {
        if include == "$self" || include == "$base" {
            // 单语法注册下，$self 与 $base 都指向本语法根（vscode-textmate 把
            // repository.$base 初始化为 $self）。
            return Some("main".to_string());
        }
        if let Some(target) = renames.get(include) {
            return Some(target.clone());
        }
        // 走到这里说明 include 不是 `#repo`，而是外部语法 scope 引用：
        // 引用自己（罕见但合法）→ main；引用别的语法 → 丢弃并对齐 TS 行为。
        if include == self.self_scope {
            return Some("main".to_string());
        }
        self.report.dropped_external_includes += 1;
        None
    }

    /// `{begin, end, …}` → push 匿名上下文。pop 规则位置编码 applyEndPatternLast。
    fn convert_begin_end(
        &mut self,
        rule: &Value,
        begin_re: &str,
        renames: &BTreeMap<String, String>,
        contexts: &mut BTreeMap<String, Vec<String>>,
        owner: &str,
        lines: &mut Vec<String>,
    ) {
        self.anon_counter += 1;
        let ctx_name = format!("anon_{}", self.anon_counter);

        // 「推进即弹栈」习惯用法：`end: '(?!\G)'` = 「解析位置一旦离开 begin 点，
        // 本块立即结束」——块只用来框住零宽 begin 后的首个内层规则。`\G` 归一化
        // 后这个 end 变成永不匹配，块就永远不弹（shell 语法的实测翻车点：shebang
        // 之后所有行失灵）。处理：识别该习惯用法并**解开块**——begin 降级为无
        // push 的普通 match（零宽时不可见），子 patterns 直接拼接进父上下文。
        // vscode-textmate 侧的实际行为（块在下一行首即弹）与拼接后的语义在
        // 「内层规则自行消费到行尾」的语法（shell/go comment）下等价。
        if rule["end"].as_str() == Some(r"(?!\G)")
            && rule["name"].as_str().is_none()
            && rule["contentName"].as_str().is_none()
        {
            self.report.unwrapped_auto_pop_blocks += 1;
            let normalized_begin = normalize_regex(begin_re, &mut self.report);
            lines.push(format!("    - match: {}\n", quote_yaml(&normalized_begin)));
            if let Some(captures) = rule["beginCaptures"].as_object() {
                push_captures(captures, &mut self.report, lines);
            }
            if let Some(sub) = rule["patterns"].as_array() {
                let sub_lines = self
                    .convert_patterns(sub, renames, contexts, owner)
                    .unwrap_or_default();
                lines.extend(sub_lines);
            }
            return;
        }

        let normalized_begin = normalize_regex(begin_re, &mut self.report);
        lines.push(format!("    - match: {}\n", quote_yaml(&normalized_begin)));
        // begin 匹配段的捕获：beginCaptures 优先，captures 兜底（textmate 语义）。
        let begin_captures = rule["beginCaptures"]
            .as_object()
            .or_else(|| rule["captures"].as_object());
        if let Some(captures) = begin_captures {
            push_captures(captures, &mut self.report, lines);
        }

        // 子上下文：meta_scope（name）/ meta_content_scope（contentName）+ 内容 + pop。
        let mut ctx_lines = Vec::new();
        if let Some(name) = rule["name"].as_str() {
            ctx_lines.push(format!("    - meta_scope: {}\n", quote_yaml(name)));
        }
        if let Some(content) = rule["contentName"].as_str() {
            ctx_lines.push(format!(
                "    - meta_content_scope: {}\n",
                quote_yaml(content)
            ));
        }

        let end_re = rule["end"]
            .as_str()
            .map(|re| normalize_regex(re, &mut self.report));
        let apply_end_last = matches!(
            rule["applyEndPatternLast"],
            Value::Bool(true) | Value::Number(_)
        );
        let mut end_rule = Vec::new();
        if let Some(end_re) = &end_re {
            let end_captures = rule["endCaptures"]
                .as_object()
                .or_else(|| rule["captures"].as_object());
            end_rule.push(format!("    - match: {}\n", quote_yaml(end_re)));
            if let Some(captures) = end_captures {
                push_captures(captures, &mut self.report, &mut end_rule);
            }
            end_rule.push("      pop: true\n".to_string());
        }
        if !apply_end_last {
            // textmate 缺省：end 先于其它 pattern 尝试 → pop 放最前。
            ctx_lines.extend(end_rule.clone());
        }
        if let Some(sub) = rule["patterns"].as_array() {
            // 子规则的 owner 是匿名上下文自己。
            let sub_lines = self
                .convert_patterns(sub, renames, contexts, &ctx_name)
                .unwrap_or_default();
            ctx_lines.extend(sub_lines);
        }
        if apply_end_last {
            ctx_lines.extend(end_rule);
        }
        contexts.insert(ctx_name.clone(), ctx_lines);
        lines.push(format!("      push: {}\n", quote_yaml(&ctx_name)));
    }
}

/// 切断自引用 include 环。
///
/// 背景：`$self`/`$base` 拼接根 patterns（映射为 `include: main`）后，语法常出现
/// `main → #block → block_innards → $base(=main)` 这样的 **eager include 环**。
/// vscode-textmate 编译时用 seen-cache 把重复拼接剪掉（环自然断开）；syntect 的
/// `Pattern::Include` 是无环检的纯拼接，环会让模式迭代器无限下钻、解析死循环。
/// 这里对每条 `→ main` 的边检查「main 能否经 include 边回到该上下文」，能则该边
/// 是环的回边 → 从所属上下文里删掉这行 include（计数进报告）。
fn cut_self_include_cycles(
    contexts: &mut BTreeMap<String, Vec<String>>,
    edges: &[(String, String, bool)],
    report: &mut ConversionReport,
) {
    // 邻接表（仅 include 边）。
    let mut adjacency: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (from, to, _) in edges {
        adjacency.entry(from).or_default().push(to);
    }

    let main_line = format!("    - include: {}\n", quote_yaml("main"));
    let mut cut: BTreeMap<&str, usize> = BTreeMap::new();
    for (from, to, is_main_edge) in edges {
        if !is_main_edge {
            continue;
        }
        // main 出发（沿 include 边）能否到达 from？能则这条 main 边在环上。
        if reachable(&adjacency, to, from) {
            *cut.entry(from).or_default() += 1;
        }
    }
    for (from, _) in cut {
        let line_count = contexts.get_mut(from).map(|lines| {
            let before = lines.len();
            lines.retain(|line| *line != main_line);
            before - lines.len()
        });
        if let Some(removed) = line_count {
            report.cut_self_include_cycles += removed;
        }
    }
}

/// DFS 可达性（图很小，环检测跑一次 O(V+E) 级别，无性能顾虑）。
fn reachable(adjacency: &BTreeMap<&str, Vec<&str>>, from: &str, to: &str) -> bool {
    if from == to {
        return true;
    }
    let mut stack: Vec<&str> = vec![from];
    let mut seen: BTreeMap<&str, ()> = BTreeMap::new();
    while let Some(node) = stack.pop() {
        if node == to {
            return true;
        }
        if seen.insert(node, ()).is_some() {
            continue;
        }
        if let Some(next) = adjacency.get(node) {
            stack.extend(next.iter().copied());
        }
    }
    false
}

/// match 规则的公共样式：scope（含 captures "0" 提升）+ captures 映射。
fn push_rule_styles(rule: &Value, report: &mut ConversionReport, lines: &mut Vec<String>) {
    let captures = rule["captures"].as_object();
    // textmate captures 的 "0" = 整个匹配 → 提升为规则级 scope（sublime-syntax 语义）。
    let zero = captures
        .and_then(|c| c.get("0"))
        .and_then(|v| v["name"].as_str());
    let name = rule["name"].as_str().or(zero);
    if let Some(name) = name {
        lines.push(format!("      scope: {}\n", quote_yaml(name)));
    }
    if let Some(captures) = captures {
        push_captures(captures, report, lines);
    }
}

/// captures 映射 → sublime-syntax `captures:` 块。capture 级子 patterns 丢弃（记账）。
fn push_captures(
    captures: &serde_json::Map<String, Value>,
    report: &mut ConversionReport,
    lines: &mut Vec<String>,
) {
    // 只保留带 name 的组；组号数值排序保证输出稳定。
    let mut entries: Vec<(u32, String)> = Vec::new();
    for (key, value) in captures {
        let Ok(index) = key.parse::<u32>() else {
            continue;
        };
        if let Some(name) = value["name"].as_str() {
            entries.push((index, name.to_string()));
        }
        if let Some(sub) = value["patterns"].as_array() {
            // capture 级子 patterns：sublime-syntax 无法给捕获组挂子规则。两种处置：
            // - **可退化**：全部子规则都是简单 `{match, name}`（常见惯用法：给组内
            //   标识符再挂一个窄 scope）→ 取首条子规则的 name 作为该组 scope。
            //   整组获得该 scope（vs 内部按更细粒度分段），对标识符类规则逐字节
            //   等价，主题匹配结果与 TS 一致（go 语法的实测收益点）。
            // - 否则丢弃并计数（结构性损失，见模块注释）。
            match flatten_capture_subpatterns(sub) {
                Some(name) => {
                    report.flattened_capture_subpatterns += sub.len();
                    entries.push((index, name));
                }
                None => {
                    report.dropped_capture_subpatterns += sub.len();
                }
            }
        }
    }
    if entries.is_empty() {
        return;
    }
    entries.sort_by_key(|(index, _)| *index);
    lines.push("      captures:\n".to_string());
    for (index, name) in entries {
        lines.push(format!("        {}: {}\n", index, quote_yaml(&name)));
    }
}

/// capture 级子 patterns 能否退化为单一 scope：全部子规则都是简单 `{match, name}`
/// 且无嵌套时，返回首条子规则的 name；否则 None（丢弃处置）。
fn flatten_capture_subpatterns(patterns: &[Value]) -> Option<String> {
    if patterns.is_empty() {
        return None;
    }
    let mut name = None;
    for rule in patterns {
        if !rule.is_object() || rule["match"].as_str().is_none() {
            return None;
        }
        if rule["begin"].is_string()
            || rule["end"].is_string()
            || rule["include"].is_string()
            || rule["patterns"].is_array()
        {
            return None;
        }
        let cur = rule["name"].as_str()?;
        name = name.or(Some(cur.to_string()));
    }
    name
}

/// oniguruma → rust/fancy-regex 的正则归一化（模块注释列了条目，各自计数）。
/// 单遍按字符扫描：`\\`（字面反斜杠）整体跳过，`(?#…)` 注释剥离，`\h`/`\G` 改写；
/// `\g<name>` 子程序调用先做组内联展开（fancy-regex 未实现该特性）。
fn normalize_regex(re: &str, report: &mut ConversionReport) -> String {
    // 0) `\g<name>` 子程序调用 → 就地展开引用组的内容（递归展开，带环保护）。
    let mut current = expand_subroutine_calls(re, report);
    // 1) `(?#…)` 内联注释剥离（注释里可能出现 \G / \h，必须先于其它归一化）。
    current = strip_inline_comments(&current, report);
    // 2) 逐转义扫描：\h → [0-9A-Fa-f]，\G → 删除。
    let normalized = normalize_escapes(&current, report);
    // 3) \G 删除可能把「裸 \G」规则削成空正则（或 `(?:)`）——空正则在每个位置
    //    都匹配零宽，配合 push 会把解析器拖进无限推进（js 语法的实测翻车点）。
    //    改写为永不匹配 `(?!)`：textmate 里裸 \G 只在续匹配点命中，禁用该规则
    //    是有界的近似（vs 全局停摆）。归一化前的原文非空，故空结果必然源自 \G。
    if normalized.is_empty() || normalized == "(?:)" {
        "(?!)".to_string()
    } else {
        normalized
    }
}

/// 展开 `\g<name>`：从同一正则里提取 `(?<name>…)` 的**平衡括号**内容，以
/// `(?:…)` 非捕获形式内联（oniguruma 子程序不产生捕获组，语义等价）。
/// 展开次数计数进 `removed_go_anchors`?——不，单独记 `expanded_subroutine_calls`。
fn expand_subroutine_calls(re: &str, report: &mut ConversionReport) -> String {
    // 提取命名组定义（`(?<name>`，排除 lookbehind 的 `(?<=`/`(?<!`）。
    let chars: Vec<char> = re.chars().collect();
    let mut definitions: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '\\' {
            index += 2; // 跳过转义段
            continue;
        }
        if chars[index] == '('
            && chars.get(index + 1) == Some(&'?')
            && chars.get(index + 2) == Some(&'<')
            && chars
                .get(index + 3)
                .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_')
        {
            let mut name = String::new();
            let mut cursor = index + 3;
            while cursor < chars.len() && chars[cursor] != '>' {
                name.push(chars[cursor]);
                cursor += 1;
            }
            cursor += 1; // 跳过 '>'
                         // 平衡括号扫描（尊重转义与字符类）。
            let body_start = cursor;
            let mut depth = 1usize;
            let mut in_class = false;
            while cursor < chars.len() && depth > 0 {
                match chars[cursor] {
                    '\\' => cursor += 1,
                    '[' if !in_class => in_class = true,
                    ']' if in_class => in_class = false,
                    '(' if !in_class => depth += 1,
                    ')' if !in_class => depth -= 1,
                    _ => {}
                }
                cursor += 1;
            }
            // cursor 停在收尾 ')' 之后。
            definitions.insert(name, (body_start, cursor.saturating_sub(1)));
            index = cursor;
            continue;
        }
        index += 1;
    }
    if definitions.is_empty() {
        return re.to_string();
    }

    // 展开 `\g<name>`（递归，带访问集防环）。
    let mut out = String::with_capacity(re.len());
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '\\' && index + 1 < chars.len() {
            if chars[index + 1] == 'g' && chars.get(index + 2) == Some(&'<') {
                let mut name = String::new();
                let mut cursor = index + 3;
                while cursor < chars.len() && chars[cursor] != '>' {
                    name.push(chars[cursor]);
                    cursor += 1;
                }
                if let Some(&(start, end)) = definitions.get(&name) {
                    report.expanded_subroutine_calls += 1;
                    let body: String = chars[start..end].iter().collect();
                    // 嵌套子程序递归展开；构造一个临时 report 避免重复计数?——
                    // 简单起见直接递归计数（嵌套调用在实际语法中为 0）。
                    let expanded = expand_subroutine_calls(&body, report);
                    out.push_str("(?:");
                    out.push_str(&expanded);
                    out.push(')');
                    index = cursor + 1;
                    continue;
                }
                // 未知名：保留原样，交给 compile 校验报错。
            }
            out.push(chars[index]);
            out.push(chars[index + 1]);
            index += 2;
            continue;
        }
        out.push(chars[index]);
        index += 1;
    }
    out
}

/// 剥离 `(?#…)` 内联注释。
fn strip_inline_comments(re: &str, report: &mut ConversionReport) -> String {
    let chars: Vec<char> = re.chars().collect();
    let mut out = String::with_capacity(re.len());
    let mut index = 0;
    while index < chars.len() {
        match chars[index] {
            '\\' => {
                out.push('\\');
                if let Some(next) = chars.get(index + 1) {
                    out.push(*next);
                }
                index += 2;
            }
            '(' if chars.get(index + 1) == Some(&'?') && chars.get(index + 2) == Some(&'#') => {
                report.stripped_inline_comments += 1;
                index += 3;
                while index < chars.len() && chars[index] != ')' {
                    index += 1;
                }
                index += 1; // 跳过收尾 `)`
            }
            ch => {
                out.push(ch);
                index += 1;
            }
        }
    }
    out
}

/// 逐转义扫描改写：`\h` → `[0-9A-Fa-f]`、`\G` → 删除；`\\` 字面反斜杠跳过。
fn normalize_escapes(re: &str, report: &mut ConversionReport) -> String {
    let chars: Vec<char> = re.chars().collect();
    let mut out = String::with_capacity(re.len());
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '\\' && index + 1 < chars.len() {
            match chars[index + 1] {
                'h' => {
                    report.normalized_hex_escapes += 1;
                    out.push_str("[0-9A-Fa-f]");
                }
                'G' => {
                    report.removed_go_anchors += 1;
                    // 删除该锚（语义损失项，报告记账）。
                }
                _ => {
                    out.push('\\');
                    out.push(chars[index + 1]);
                }
            }
            index += 2;
            continue;
        }
        out.push(chars[index]);
        index += 1;
    }
    out
}

/// YAML 双引号标量转义：反斜杠、双引号、控制符。非 ASCII 原样透传（UTF-8）。
fn quote_yaml(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 空仓库 + 单 match 的最小语法能转出合法 YAML 骨架。
    #[test]
    fn minimal_grammar_roundtrip() {
        let grammar: Value = serde_json::from_str(
            r#"{"scopeName": "source.test", "names": ["Test"],
                "patterns": [{"match": "\\bfoo\\b", "name": "keyword.test"}]}"#,
        )
        .unwrap();
        let converted = tm_language_to_sublime_syntax(&grammar).unwrap();
        assert!(converted.yaml.contains("scope: \"source.test\""));
        assert!(converted.yaml.contains("- match: \"\\\\bfoo\\\\b\""));
        assert!(converted.yaml.contains("scope: \"keyword.test\""));
        assert_eq!(converted.report.unexpected_losses(), Vec::<&str>::new());
    }

    /// include 分支：#repo 映射、$self → main、外部 scope 丢弃并计数。
    /// 环检测：被 main **eager** include 到的上下文里，`→ main` 的边都是回边，
    /// 一律切断（vscode-textmate 编译期 seen-cache 的等价行为）；注意 r##：
    /// JSON 里的 `"#inner"` 会提前终止 r# 串。
    #[test]
    fn include_resolution_branches() {
        let grammar: Value = serde_json::from_str(
            r##"{"scopeName": "source.test",
                "patterns": [
                  {"include": "#inner"},
                  {"include": "$self"},
                  {"include": "source.other"},
                  {"include": "source.test"}
                ],
                "repository": {
                  "inner": {"patterns": [
                    {"include": "$self"},
                    {"match": "x", "name": "k.test"}
                  ]}
                }}"##,
        )
        .unwrap();
        let converted = tm_language_to_sublime_syntax(&grammar).unwrap();
        assert_eq!(converted.report.dropped_external_includes, 1);
        // 三条回边：根上的 $self 与 self-scope 引用（main→main 自环）、
        // inner 里的 $self（main→inner→main）。
        assert_eq!(converted.report.cut_self_include_cycles, 3);
        let main_section = &converted.yaml[converted.yaml.find("contexts:").unwrap()..];
        let main_ctx = section_of(&main_section, "main");
        assert!(
            main_ctx.contains("- include: \"inner\""),
            "非环 #repo 引用保留"
        );
        assert_eq!(
            main_ctx.matches("- include:").count(),
            1,
            "main 只剩 #inner 一条 include"
        );
        let inner = section_of(&converted.yaml, "inner");
        assert!(
            !inner.contains("- include: \"main\""),
            "inner 的回边应被切断"
        );
        assert!(inner.contains("k.test"), "非 include 规则保留");
    }

    /// push 型引用（begin/end 的子上下文）不构成 eager 环 → 其中的 $self 保留。
    #[test]
    fn self_include_inside_pushed_context_is_kept() {
        let grammar: Value = serde_json::from_str(
            r##"{"scopeName": "source.test",
                "patterns": [
                  {"begin": "{", "end": "}", "name": "b.test",
                   "patterns": [{"include": "$self"}]}
                ]}"##,
        )
        .unwrap();
        let converted = tm_language_to_sublime_syntax(&grammar).unwrap();
        assert_eq!(converted.report.cut_self_include_cycles, 0);
        let anon1 = section_of(&converted.yaml, "anon_1");
        assert!(anon1.contains("- include: \"main\""));
    }

    /// eager include 环（main → block → innards → $base=main）被切断，
    /// 且切断的是回边（innards 里的 main include），环外引用不受影响。
    #[test]
    fn self_include_cycle_is_cut_at_back_edge() {
        let grammar: Value = serde_json::from_str(
            r##"{"scopeName": "source.test",
                "patterns": [{"include": "#block"}],
                "repository": {
                  "block": {"patterns": [{"include": "#innards"}]},
                  "innards": {"patterns": [
                    {"include": "$base"},
                    {"match": "y", "name": "k.test"}
                  ]}
                }}"##,
        )
        .unwrap();
        let converted = tm_language_to_sublime_syntax(&grammar).unwrap();
        assert_eq!(converted.report.cut_self_include_cycles, 1);
        let innards = section_of(&converted.yaml, "innards");
        assert!(!innards.contains("- include: \"main\""), "回边应被删除");
        assert!(innards.contains("k.test"), "非 include 规则保留");
    }

    /// begin/end → push + pop 首位；applyEndPatternLast → pop 排到内容之后。
    /// 用带子规则的用例才能断言 pop 与子规则的相对顺序。
    #[test]
    fn begin_end_conversion_positions_pop_rule() {
        let grammar: Value = serde_json::from_str(
            r#"{"scopeName": "source.test",
                "patterns": [
                  {"begin": "A", "end": "B", "name": "string.test",
                   "patterns": [{"match": "x", "name": "k.test"}]},
                  {"begin": "C", "end": "D", "name": "string.other",
                   "applyEndPatternLast": 1,
                   "patterns": [{"match": "y", "name": "k.other"}]}
                ]}"#,
        )
        .unwrap();
        let converted = tm_language_to_sublime_syntax(&grammar).unwrap();

        // anon_1（缺省）：pop 必须先于子规则（textmate 里 end 优先于其它 pattern）。
        let anon1 = section_of(&converted.yaml, "anon_1");
        let pop = anon1.find("pop: true").expect("anon_1 有 pop");
        let sub = anon1.find("- match: \"x\"").expect("anon_1 有子规则");
        assert!(pop < sub, "缺省时 pop 应在子规则之前");

        // anon_2（applyEndPatternLast）：pop 必须排在子规则之后。
        let anon2 = section_of(&converted.yaml, "anon_2");
        let pop = anon2.find("pop: true").expect("anon_2 有 pop");
        let sub = anon2.find("- match: \"y\"").expect("anon_2 有子规则");
        assert!(sub < pop, "applyEndPatternLast 时 pop 应在子规则之后");
    }

    /// capture "0" 提升为 scope；简单 capture 子 patterns 退化为组 scope（保留），
    /// 复杂子 patterns（含 begin/end）丢弃并计数。
    #[test]
    fn capture_zero_promoted_and_subpatterns() {
        let grammar: Value = serde_json::from_str(
            r#"{"scopeName": "source.test",
                "patterns": [{"match": "(a)(b)", "captures": {
                  "0": {"name": "zero.test"},
                  "1": {"name": "one.test"},
                  "2": {"patterns": [
                    {"match": "b", "name": "two.simple"},
                    {"begin": "'", "end": "'", "name": "two.complex"}
                  ]}
                }}]}"#,
        )
        .unwrap();
        let converted = tm_language_to_sublime_syntax(&grammar).unwrap();
        // 整组语义：组 2 混含简单与复杂子规则 → 不可退化，整组丢弃（2 条）。
        assert_eq!(converted.report.dropped_capture_subpatterns, 2);
        assert_eq!(converted.report.flattened_capture_subpatterns, 0);
        assert!(converted.yaml.contains("scope: \"zero.test\""));
        assert!(
            !converted.yaml.contains("two.simple"),
            "不可退化组内的规则不应保留"
        );

        // 纯简单子规则的组：整组退化为首条子规则的 scope。
        let grammar: Value = serde_json::from_str(
            r#"{"scopeName": "source.test",
                "patterns": [{"match": "(a)(b)", "captures": {
                  "1": {"name": "one.test"},
                  "2": {"patterns": [{"match": "b", "name": "two.simple"}]}
                }}]}"#,
        )
        .unwrap();
        let converted = tm_language_to_sublime_syntax(&grammar).unwrap();
        assert_eq!(converted.report.flattened_capture_subpatterns, 1);
        assert_eq!(converted.report.dropped_capture_subpatterns, 0);
        assert!(converted.yaml.contains("2: \"two.simple\""));
    }

    /// 正则归一化：\h、\G、(?#…) 三条各自生效并计数；字面 `\\` 不被误改。
    #[test]
    fn regex_normalization_cases() {
        let mut report = ConversionReport::default();
        assert_eq!(normalize_regex(r"\h+", &mut report), "[0-9A-Fa-f]+");
        assert_eq!(report.normalized_hex_escapes, 1);

        let mut report = ConversionReport::default();
        assert_eq!(normalize_regex(r"\G(@)media", &mut report), "(@)media");
        assert_eq!(report.removed_go_anchors, 1);

        let mut report = ConversionReport::default();
        assert_eq!(
            normalize_regex(r"(?# why)abc\\hdef", &mut report),
            "abc\\\\hdef",
            "字面反斜杠后的 h 不是转义 \\h"
        );
        assert_eq!(report.stripped_inline_comments, 1);
        assert_eq!(report.normalized_hex_escapes, 0);
    }

    /// 取 YAML 里某个上下文名的段（到下一个同级键为止），供结构断言。
    fn section_of(yaml: &str, name: &str) -> String {
        let start = yaml.find(&format!("  \"{name}\":\n")).expect("段存在");
        let rest = &yaml[start + 1..];
        let end = rest.find("\n  \"").map_or(rest.len(), |pos| pos + 1);
        rest[..end].to_string()
    }
}
