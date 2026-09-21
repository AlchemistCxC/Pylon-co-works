//! starry-night 类名主题层：vscode-textmate 的 Theme 匹配算法移植 + github `pl-*`
//! 类名表（`assets/starry-theme.json`，由 `gen/generate-assets.mjs` 从
//! `@wooorm/starry-night/lib/theme.js` 原样导出）。
//!
//! 为什么照抄 vscode-textmate 而不用 syntect 的 `Highlighter`/`style_for_stack`：
//! 两者对「scope 栈 → 主题规则」的算法**不同**——
//! - syntect：对全部主题条目按 TextMate match-power 打分取最高（选择器末段可以
//!   只匹配栈的前缀）；
//! - vscode-textmate（9.x `Theme::match`）：只看**栈顶 scope** 的点分段定位
//!   trie 节点，节点上按「特异度」排序的规则里取**第一条**父链能匹配祖先栈的。
//! parity 要求与 TS 基线逐 token 一致，所以按 vscode-textmate 移植，不按 syntect。
//!
//! 算法对应关系（v9.3.2 源码，逐函数移植，勿凭印象改）：
//! - `parseTheme` + `resolveParsedThemeRules`（theme.ts）：规则解析/排序/默认值，
//!   以及**点分 trie** 构建（子节点在创建时刻继承父节点当时的 mainRule 与
//!   parent 规则——继承发生在插入序上，顺序敏感，照抄）。
//! - `_cmpBySpecificity`：特异度 = ① scopeDepth 深者优先 → ② 父链逐段比段长 →
//!   ③ 父链更长者优先。
//! - `_scopePathMatchesParentScopes`：父链从最内层祖先向上找，`>` 为子代约束。
//! - `AttributedScopeStack._pushAttributed` + `mergeAttributes`：**帧继承**——
//!   每压一个 scope 用该帧的匹配结果覆盖（fontStyle=`NotSet`/前景=无色 → 沿用
//!   前一帧）；token 取最内层帧。对 syntect 给出的最终 scope 栈**按前缀重放**
//!   即可等价重建（帧是栈前缀的纯函数）。
//! - starry `parse.js` 的解码：fontStyle 非零 → `pl-s`（唯一「祖类」），背景色
//!   类在前、前景色类在后（类链顺序 = hast 嵌套顺序）。
//! - `resolveParsedThemeRules` 的默认帧：starry 主题首条无 scope 规则把
//!   前景/背景都置为 `#FFFFFF`（= transparent），所以「无匹配」= 无类。

use std::collections::HashMap;

use serde::Deserialize;

/// 单个 token 的类名推导结果（对应 starry `parse.js` 解码出的三元组）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenStyle {
    /// fontStyle 位掩码（Italic=1/Bold=2/Underline=4/Strikethrough=8），恒 ≥ 0。
    pub font_style: i32,
    /// 背景色映射出的类名（先嵌套，多数为 None）。
    pub bg_class: Option<String>,
    /// 前景色映射出的类名（后嵌套，主体来源）。
    pub fg_class: Option<String>,
}

impl TokenStyle {
    /// hast 嵌套链（外→内）。starry `parse.js` 的 delve 顺序：
    /// fontStyle 类 → 背景类 → 前景类。
    pub fn class_chain(&self, theme: &StarryTheme) -> Vec<String> {
        let mut chain = Vec::with_capacity(3);
        if self.font_style != 0 {
            if let Some(grandparent) = theme.grandparents.first() {
                chain.push(grandparent.clone());
            }
        }
        if let Some(class) = &self.bg_class {
            chain.push(class.clone());
        }
        if let Some(class) = &self.fg_class {
            chain.push(class.clone());
        }
        chain
    }
}

/// 解析后的主题（一次性构建，wasm 内常驻）。
pub struct StarryTheme {
    /// starry 的 sorted classes（颜色序号 → 类名，从 theme.json 原样带入）。
    classes: Vec<String>,
    /// 「祖类」列表——fontStyle 非零时套上的类；starry 只有一个 `pl-s`。
    grandparents: Vec<String>,
    /// 透明色字面量（该色 → 无类）。starry 固定 `#FFFFFF`。
    transparent: String,
    defaults: FrameStyle,
    root: TrieNode,
}

/// 帧样式：fontStyle 的 `-1` 表示 NotSet（沿帧继承，不覆盖）；
/// 颜色 `None` 表示「无色」（= vscode-textmate 的 color id 0，同样沿帧继承）。
#[derive(Debug, Clone, PartialEq, Eq)]
struct FrameStyle {
    font_style: i32,
    foreground: Option<String>,
    background: Option<String>,
}

/// trie 节点上的规则（vscode-textmate `ThemeTrieElementRule`）。
#[derive(Debug, Clone)]
struct TrieRule {
    scope_depth: usize,
    /// `None` = 主规则（parentScopes 为空的语义）；`Some` 已按 textmate 反转。
    parent_scopes: Option<Vec<String>>,
    font_style: i32,
    foreground: Option<String>,
    background: Option<String>,
}

#[derive(Debug, Default)]
struct TrieNode {
    main_rule: Option<TrieRule>,
    rules_with_parent_scopes: Vec<TrieRule>,
    children: HashMap<String, TrieNode>,
}

// ── theme.json 的 serde 形状（gen/generate-assets.mjs 的产物） ──────────────

#[derive(Deserialize)]
struct ThemeAsset {
    classes: Vec<String>,
    grandparents: Vec<String>,
    transparent: String,
    settings: Vec<SettingEntry>,
}

#[derive(Deserialize)]
struct SettingEntry {
    #[serde(default)]
    scope: Option<ScopeSpec>,
    settings: RawSettings,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ScopeSpec {
    One(String),
    Many(Vec<String>),
}

#[derive(Deserialize)]
struct RawSettings {
    #[serde(default, rename = "fontStyle")]
    font_style: Option<String>,
    #[serde(default)]
    foreground: Option<String>,
    #[serde(default)]
    background: Option<String>,
}

/// fontStyle 关键字 → 位（vscode-textmate `FontStyle`）。
const FONT_STYLE_ITALIC: i32 = 1;
const FONT_STYLE_BOLD: i32 = 2;
const FONT_STYLE_UNDERLINE: i32 = 4;
const FONT_STYLE_STRIKETHROUGH: i32 = 8;
/// vscode-textmate `FontStyle.NotSet`。
const FONT_STYLE_NOT_SET: i32 = -1;

impl StarryTheme {
    /// 从 theme.json 内容构建（`assets/starry-theme.json` 的 include_str!）。
    pub fn from_asset(json: &str) -> Result<StarryTheme, String> {
        let asset: ThemeAsset = serde_json::from_str(json)
            .map_err(|error| format!("starry-theme.json 解析失败: {error}"))?;
        let mut rules = parse_theme(&asset.settings)?;
        let defaults = resolve_defaults(&mut rules);
        let root = build_trie(rules);
        Ok(StarryTheme {
            classes: asset.classes,
            grandparents: asset.grandparents,
            transparent: asset.transparent,
            defaults,
            root,
        })
    }

    /// 对 scope 栈（root → 内层，syntect `ScopeStack` 的顺序）求 token 样式。
    ///
    /// 实现说明：vscode-textmate 是「逐帧」计算的（每压一个 scope 算一次），
    /// 帧是栈前缀的纯函数，因此对最终栈做**前缀重放**（帧 0 = 语法根 scope）。
    pub fn match_stack(&self, scopes: &[&str]) -> TokenStyle {
        let mut font_style = self.defaults.font_style;
        let mut foreground = self.defaults.foreground.clone();
        let mut background = self.defaults.background.clone();
        for (depth, scope) in scopes.iter().enumerate() {
            let rule = self.match_frame(scope, &scopes[..depth]);
            // mergeAttributes + EncodedTokenAttributes.set：NotSet / 无色沿帧继承。
            if rule.font_style != FONT_STYLE_NOT_SET {
                font_style = rule.font_style;
            }
            if let Some(color) = &rule.foreground {
                foreground = Some(color.clone());
            }
            if let Some(color) = &rule.background {
                background = Some(color.clone());
            }
        }
        TokenStyle {
            font_style,
            bg_class: self.color_to_class(background.as_deref()),
            fg_class: self.color_to_class(foreground.as_deref()),
        }
    }

    /// 单帧匹配：栈顶 scope 定位 trie 节点，取第一条父链匹配祖先的规则。
    fn match_frame(&self, scope: &str, ancestors: &[&str]) -> FrameStyle {
        let mut node = &self.root;
        // 点分段下钻；子节点缺失时停在当前节点（继承父节点的规则表）。
        for segment in scope.split('.') {
            match node.children.get(segment) {
                Some(child) => node = child,
                None => break,
            }
        }
        // 候选 = 父链规则 + 主规则，按特异度排序后取第一条父链匹配的。
        let mut candidates: Vec<&TrieRule> = node
            .rules_with_parent_scopes
            .iter()
            .chain(node.main_rule.as_ref().into_iter())
            .collect();
        candidates.sort_by(|a, b| cmp_by_specificity(a, b));
        let effective = candidates
            .into_iter()
            .find(|rule| matches_parent_scopes(ancestors, rule))
            .expect("主规则 parentScopes 恒为空、恒匹配，find 不会落空");
        FrameStyle {
            font_style: effective.font_style,
            foreground: effective.foreground.clone(),
            background: effective.background.clone(),
        }
    }

    /// starry `parse.js` 的 colorToClass：透明 → 无类；其余按颜色字面量的十进制
    /// 尾数索引 sorted classes。`None`（无色）同样无类。
    fn color_to_class(&self, color: Option<&str>) -> Option<String> {
        let color = color?;
        if color == self.transparent {
            return None;
        }
        let digits = color.strip_prefix('#')?;
        let index: usize = digits.parse().ok()?;
        self.classes.get(index).cloned()
    }
}

// ── parseTheme ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct ParsedRule {
    /// 选择器最后一段（`''` = 无 scope 的默认规则）。
    scope: String,
    /// 前置父链（已按 textmate 约定**反转**：index 0 = 最深父）。
    parent_scopes: Option<Vec<String>>,
    /// settings 数组中的原始下标（排序 tie-break）。
    index: usize,
    font_style: i32,
    foreground: Option<String>,
    background: Option<String>,
}

fn parse_theme(settings: &[SettingEntry]) -> Result<Vec<ParsedRule>, String> {
    let mut rules = Vec::new();
    for (index, entry) in settings.iter().enumerate() {
        let scopes: Vec<String> = match &entry.scope {
            None => vec![String::new()],
            Some(ScopeSpec::One(s)) => {
                // textmate 语义：去首尾逗号后按逗号拆。
                s.trim_start_matches(',')
                    .trim_end_matches(',')
                    .to_string()
                    .split(',')
                    .map(str::to_string)
                    .collect()
            }
            Some(ScopeSpec::Many(v)) => v.clone(),
        };
        let font_style = match &entry.settings.font_style {
            None => FONT_STYLE_NOT_SET,
            Some(spec) => {
                let mut mask = 0;
                for word in spec.split(' ') {
                    mask |= match word {
                        "italic" => FONT_STYLE_ITALIC,
                        "bold" => FONT_STYLE_BOLD,
                        "underline" => FONT_STYLE_UNDERLINE,
                        "strikethrough" => FONT_STYLE_STRIKETHROUGH,
                        _ => 0,
                    };
                }
                mask
            }
        };
        let foreground = valid_hex(entry.settings.foreground.as_deref());
        let background = valid_hex(entry.settings.background.as_deref());
        for raw_scope in scopes {
            let raw_scope = raw_scope.trim().to_string();
            // 最后一个空分段 = 目标 scope；其余反转成父链（`>` 段原样保留）。
            let mut segments = raw_scope.split(' ').filter(|s| !s.is_empty());
            let mut parts: Vec<String> = segments.by_ref().map(str::to_string).collect();
            let scope = if parts.is_empty() {
                String::new()
            } else {
                parts.pop().expect("非空必有尾元素")
            };
            let parent_scopes = if parts.is_empty() {
                None
            } else {
                parts.reverse();
                Some(parts)
            };
            rules.push(ParsedRule {
                scope,
                parent_scopes,
                index,
                font_style,
                foreground: foreground.clone(),
                background: background.clone(),
            });
        }
    }
    Ok(rules)
}

/// vscode-textmate `isValidHexColor`：`#` + 6 或 8 位十六进制。
fn valid_hex(color: Option<&str>) -> Option<String> {
    let color = color?;
    let hex = color.strip_prefix('#')?;
    if hex.len() != 6 && hex.len() != 8 {
        return None;
    }
    hex.chars()
        .all(|c| c.is_ascii_hexdigit())
        .then(|| color.to_uppercase())
}

// ── resolveParsedThemeRules：排序 + 默认值 + trie ───────────────────────────

/// 规则排序：scope 字典序 → 父链字典序（None 最小）→ settings 下标。
fn sort_rules(rules: &mut [ParsedRule]) {
    rules.sort_by(|a, b| {
        let by_scope = a.scope.cmp(&b.scope);
        if by_scope != std::cmp::Ordering::Equal {
            return by_scope;
        }
        let by_parents = str_arr_cmp(&a.parent_scopes, &b.parent_scopes);
        if by_parents != std::cmp::Ordering::Equal {
            return by_parents;
        }
        a.index.cmp(&b.index)
    });
}

/// vscode-textmate `strArrCmp`：None(null) 最小，其余逐元素字典序。
fn str_arr_cmp(a: &Option<Vec<String>>, b: &Option<Vec<String>>) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    match (a, b) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Less,
        (Some(_), None) => Ordering::Greater,
        (Some(a), Some(b)) => a.cmp(b),
    }
}

/// 无 scope 的规则收敛为默认帧（starry：前景/背景 = #FFFFFF = 透明）。
fn resolve_defaults(rules: &mut Vec<ParsedRule>) -> FrameStyle {
    let mut defaults = FrameStyle {
        font_style: 0, // FontStyle.None（不是 NotSet！）
        foreground: Some("#000000".to_string()),
        background: Some("#ffffff".to_string()),
    };
    sort_rules(rules);
    while let Some(first) = rules.first() {
        if first.scope != "" {
            break;
        }
        let rule = rules.remove(0);
        if rule.font_style != FONT_STYLE_NOT_SET {
            defaults.font_style = rule.font_style;
        }
        if rule.foreground.is_some() {
            defaults.foreground = rule.foreground;
        }
        if rule.background.is_some() {
            defaults.background = rule.background;
        }
    }
    defaults
}

/// trie 构建（插入序敏感：子节点创建时克隆父节点**当时**的规则表）。
fn build_trie(rules: Vec<ParsedRule>) -> TrieNode {
    let mut root = TrieNode {
        main_rule: Some(TrieRule {
            scope_depth: 0,
            parent_scopes: None,
            font_style: FONT_STYLE_NOT_SET,
            foreground: None,
            background: None,
        }),
        ..TrieNode::default()
    };
    for rule in rules {
        insert_rule(
            &mut root,
            0,
            &rule.scope,
            rule.parent_scopes,
            rule.font_style,
            rule.foreground,
            rule.background,
        );
    }
    root
}

fn insert_rule(
    node: &mut TrieNode,
    depth: usize,
    scope: &str,
    parent_scopes: Option<Vec<String>>,
    font_style: i32,
    foreground: Option<String>,
    background: Option<String>,
) {
    if scope.is_empty() {
        do_insert_here(
            node,
            depth,
            parent_scopes,
            font_style,
            foreground,
            background,
        );
        return;
    }
    // 按第一个点分段下钻；无点则整段。
    let (head, tail) = match scope.split_once('.') {
        Some((head, tail)) => (head, tail),
        None => (scope, ""),
    };
    let child = node.children.entry(head.to_string()).or_insert_with(|| {
        // 克隆当前节点的规则表（继承发生在创建时刻——顺序敏感，照抄 textmate）。
        TrieNode {
            main_rule: node.main_rule.clone(),
            rules_with_parent_scopes: node.rules_with_parent_scopes.clone(),
            children: HashMap::new(),
        }
    });
    insert_rule(
        child,
        depth + 1,
        tail,
        parent_scopes,
        font_style,
        foreground,
        background,
    );
}

fn do_insert_here(
    node: &mut TrieNode,
    depth: usize,
    parent_scopes: Option<Vec<String>>,
    font_style: i32,
    foreground: Option<String>,
    background: Option<String>,
) {
    match parent_scopes {
        None => {
            // 并入主规则（acceptOverwrite）。
            let rule = node.main_rule.get_or_insert_with(|| TrieRule {
                scope_depth: depth,
                parent_scopes: None,
                font_style: FONT_STYLE_NOT_SET,
                foreground: None,
                background: None,
            });
            if rule.scope_depth <= depth {
                rule.scope_depth = depth;
            }
            if font_style != FONT_STYLE_NOT_SET {
                rule.font_style = font_style;
            }
            if foreground.is_some() {
                rule.foreground = foreground;
            }
            if background.is_some() {
                rule.background = background;
            }
        }
        Some(parent_scopes) => {
            // 同父链规则合并。
            if let Some(existing) = node
                .rules_with_parent_scopes
                .iter_mut()
                .find(|rule| rule.parent_scopes.as_ref() == Some(&parent_scopes))
            {
                if existing.scope_depth <= depth {
                    existing.scope_depth = depth;
                }
                if font_style != FONT_STYLE_NOT_SET {
                    existing.font_style = font_style;
                }
                if foreground.is_some() {
                    existing.foreground = foreground;
                }
                if background.is_some() {
                    existing.background = background;
                }
                return;
            }
            // 新规则：未设字段继承主规则。
            let main = node.main_rule.clone().unwrap_or(TrieRule {
                scope_depth: 0,
                parent_scopes: None,
                font_style: FONT_STYLE_NOT_SET,
                foreground: None,
                background: None,
            });
            node.rules_with_parent_scopes.push(TrieRule {
                scope_depth: depth,
                parent_scopes: Some(parent_scopes),
                font_style: if font_style != FONT_STYLE_NOT_SET {
                    font_style
                } else {
                    main.font_style
                },
                foreground: foreground.or(main.foreground),
                background: background.or(main.background),
            });
        }
    }
}

// ── 匹配 ────────────────────────────────────────────────────────────────────

/// `_cmpBySpecificity`：① scopeDepth 深者优先 → ② 父链逐段比段长 → ③ 父链长者优先。
fn cmp_by_specificity(a: &TrieRule, b: &TrieRule) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    if a.scope_depth != b.scope_depth {
        return b.scope_depth.cmp(&a.scope_depth);
    }
    let a_parents = a.parent_scopes.as_deref().unwrap_or(&[]);
    let b_parents = b.parent_scopes.as_deref().unwrap_or(&[]);
    let mut a_index = 0;
    let mut b_index = 0;
    loop {
        // 子代组合符 `>` 不影响特异度——跳过。
        if a_parents.get(a_index).map(String::as_str) == Some(">") {
            a_index += 1;
        }
        if b_parents.get(b_index).map(String::as_str) == Some(">") {
            b_index += 1;
        }
        match (a_parents.get(a_index), b_parents.get(b_index)) {
            (Some(a_scope), Some(b_scope)) => {
                let diff = b_scope.len().cmp(&a_scope.len());
                if diff != Ordering::Equal {
                    return diff;
                }
                a_index += 1;
                b_index += 1;
            }
            _ => break,
        }
    }
    // 平局：父链更长者优先。
    b_parents.len().cmp(&a_parents.len())
}

/// `_scopePathMatchesParentScopes`：`ancestors` 是**栈根 → 最内层祖先**的顺序，
/// 父链从 index 0（最深父）起、沿祖先栈**自内向外**找。
fn matches_parent_scopes(ancestors: &[&str], rule: &TrieRule) -> bool {
    let Some(parent_scopes) = rule.parent_scopes.as_ref() else {
        return true; // 主规则：父链为空恒匹配
    };
    if parent_scopes.is_empty() {
        return true;
    }
    let mut position = ancestors.len(); // 自内向外走：从末尾往前
    let mut index = 0;
    while index < parent_scopes.len() {
        let mut pattern = parent_scopes[index].as_str();
        let mut must_match = false;
        if pattern == ">" {
            if index == parent_scopes.len() - 1 {
                return false; // 无效的子代组合符用法
            }
            index += 1;
            pattern = parent_scopes[index].as_str();
            must_match = true;
        }
        // 沿祖先栈向上找匹配段。
        loop {
            if position == 0 {
                return false; // 祖先栈走完仍无匹配
            }
            position -= 1;
            if matches_scope(ancestors[position], pattern) {
                break;
            }
            if must_match {
                return false;
            }
        }
        index += 1;
    }
    true
}

/// `_matchesScope`：全等，或「前缀 + 紧跟点分段」。
fn matches_scope(scope_name: &str, pattern: &str) -> bool {
    scope_name == pattern
        || (scope_name.len() > pattern.len()
            && scope_name.starts_with(pattern)
            && scope_name.as_bytes()[pattern.len()] == b'.')
}

// ── 测试 ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// 用 starry theme.js 的**真实形状**（少量条目 + 默认透明条）验证全链路：
    /// 无匹配 scope → 无类；keyword → pl-k；string → fontStyle → pl-s。
    #[test]
    fn class_mapping_end_to_end() {
        let asset = serde_json::json!({
            "classes": ["pl-c", "pl-ent", "pl-k", "pl-s"],
            "grandparents": ["pl-s"],
            "transparent": "#FFFFFF",
            "settings": [
                {"settings": {"background": "#FFFFFF", "foreground": "#FFFFFF"}},
                {"scope": ["comment"], "settings": {"foreground": "#000000"}},
                {"scope": ["keyword"], "settings": {"foreground": "#000002"}},
                {"scope": ["string"], "settings": {"fontStyle": "italic"}},
                {"scope": ["entity.name.tag"], "settings": {"foreground": "#000001"}},
                {"scope": ["string source"], "settings": {"foreground": "#000003"}}
            ]
        });
        let theme = StarryTheme::from_asset(&asset.to_string()).unwrap();

        // 无匹配（栈顶 source.rust）：默认帧两色皆透明 → 无类、无 fontStyle。
        let style = theme.match_stack(&["source.rust"]);
        assert_eq!(
            style,
            TokenStyle {
                font_style: 0,
                bg_class: None,
                fg_class: None
            }
        );

        // 栈顶 keyword.control.rust：点分下钻停于 keyword 节点 → pl-k。
        let style = theme.match_stack(&["source.js", "keyword.control.js"]);
        assert_eq!(style.fg_class.as_deref(), Some("pl-k"));
        assert_eq!(style.class_chain(&theme), vec!["pl-k".to_string()]);

        // 栈顶 string：fontStyle 规则 → pl-s（祖类）。
        let style = theme.match_stack(&["source.js", "string.quoted.double.js"]);
        assert_eq!(style.font_style, FONT_STYLE_ITALIC);
        assert_eq!(style.class_chain(&theme), vec!["pl-s".to_string()]);

        // 栈顶 entity.name.tag + 祖先 string：父链匹配（string … entity）。
        // textmate 语义：父链沿祖先自内向外找，string 在祖先链上 → 命中。
        let style = theme.match_stack(&["text.html.basic", "string.quoted", "entity.name.tag"]);
        assert_eq!(style.fg_class.as_deref(), Some("pl-ent"));

        // 类链顺序：fontStyle → bg → fg（starry delve 顺序）。
        let asset2 = serde_json::json!({
            "classes": ["pl-a", "pl-b"],
            "grandparents": ["pl-s"],
            "transparent": "#FFFFFF",
            "settings": [
                {"settings": {"background": "#FFFFFF", "foreground": "#FFFFFF"}},
                {"scope": ["x"], "settings": {"fontStyle": "italic", "foreground": "#000000", "background": "#000001"}}
            ]
        });
        let theme2 = StarryTheme::from_asset(&asset2.to_string()).unwrap();
        let style = theme2.match_stack(&["x"]);
        assert_eq!(
            style.class_chain(&theme2),
            vec!["pl-s".to_string(), "pl-b".to_string(), "pl-a".to_string()]
        );
    }

    /// 特异度取舍：更深的 scopeDepth 胜过更浅者（同为栈顶匹配时）。
    #[test]
    fn specificity_prefers_deeper_scope() {
        let asset = serde_json::json!({
            "classes": ["pl-shallow", "pl-deep"],
            "grandparents": [],
            "transparent": "#FFFFFF",
            "settings": [
                {"settings": {"background": "#FFFFFF", "foreground": "#FFFFFF"}},
                {"scope": ["keyword"], "settings": {"foreground": "#000000"}},
                {"scope": ["keyword.control"], "settings": {"foreground": "#000001"}}
            ]
        });
        let theme = StarryTheme::from_asset(&asset.to_string()).unwrap();
        let style = theme.match_stack(&["source.js", "keyword.control.js"]);
        assert_eq!(style.fg_class.as_deref(), Some("pl-deep"));
    }

    /// 父链特异度：带更长父链的规则胜过无父链的（`string source` 优先于 `string`）。
    #[test]
    fn specificity_prefers_parent_scoped_rule() {
        let asset = serde_json::json!({
            "classes": ["pl-plain", "pl-embedded"],
            "grandparents": [],
            "transparent": "#FFFFFF",
            "settings": [
                {"settings": {"background": "#FFFFFF", "foreground": "#FFFFFF"}},
                {"scope": ["string"], "settings": {"foreground": "#000000"}},
                {"scope": ["string source"], "settings": {"foreground": "#000001"}}
            ]
        });
        let theme = StarryTheme::from_asset(&asset.to_string()).unwrap();
        // 无 source 祖先 → 命中 `string`。
        let style = theme.match_stack(&["source.js", "string.quoted"]);
        assert_eq!(style.fg_class.as_deref(), Some("pl-plain"));
        // 有 source 祖先 → 命中 `string source`（父链更特异）。
        let style = theme.match_stack(&["source.js", "string.quoted", "source.js.embedded"]);
        assert_eq!(style.fg_class.as_deref(), Some("pl-embedded"));
    }
}
