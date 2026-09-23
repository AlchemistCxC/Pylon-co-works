# Dev Record — #238 刀6 设置页中控区改成「元件 → 子部件」分组

> 入库保留。施工单：`E:\Acode\FILES\任务\工作台优化\元件定义表\11-施工单-刀6-设置页按元件与子部件分组.md`
> 规范：同目录 `00-施工规范-中控元件定义表-v1.0.md` §7（刀6 行）；分支 `feat/cc-widget-definition-table`

## 元信息

- issue：[#238](https://github.com/AlchemistCxC/Pylon-co-works/issues/238)
- 分支：`feat/cc-widget-definition-table`（**未 push、未开 PR**）
- 提交范围：`e70f75ac..f064d6ce`（`e70f75ac` L.md 声明 → `f064d6ce` 实现）
- 日期：2026-09-23
- 用户口径（2026-09-23）：**归属放在字段**（`def.group` = 真值）、**要二级**（元件 → 子部件 → 项，「方便分块管理」）、
  **没用的清理掉**、**`cc-surface` 不拆**（保持 1 个子部件 / 9 项）

## 目标与范围

把中控区设置页的分组从"历史标签"改成「**元件 → 子部件 → 项**」，**让成员层第一次被真正消费**，
并清掉两个只有标题的分类。**行动要求是有视觉变化**（设置页结构变）⇒ 实机取证；
★ **字段集合必须一个不少**（只是换了归属）⇒ 写成不变量。

**不做**：中控渲染（刀3/4/5 地盘）、主题字段的**值**与默认值、three hidden 字段的归属、
插件契约面、成员级显隐收编（已另立待办）、`ccVariant` 的存废（刀8）。

## 改动清单（7 文件）

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/themeFieldDefs.ts` | ① 78 个 cc 字段的 `group:` 值 → 所属**子部件 label**（机械替换，见下）；② 新增 `CC_MEMBER_FIELDS`（成员 label → 字段键，**派生**）；③ `GROUP_ORDER.cc` 改**派生**（分区 = 元件 label，组 = 有可调项的子部件 label）；④ 连带 `renderableMemberFields()` 私有辅助 | 修改 |
| `src/domains/cc/widgetDefinitions.ts` | 删掉 20 个成员行里的手写 `fields: [...]`；删掉 `CcWidgetMember.fields` 类型栏位，换成指向新真值的注释 | 修改（−155 / +12） |
| `src/domains/cc/__tests__/widgetDefinitionTable.test.ts` | 4 处 `member.fields` → 读 `CC_MEMBER_FIELDS`（新增 `fieldsOf()` helper）；「归属逐条锁定」那条改按**集合**比对（见「偏差」2） | 修改 |
| **新增** `src/domains/cc/__tests__/ccSettingsGrouping.test.ts` | §4-2 的字段集合不变量（6 条用例） | **新增** |
| `src/themeFieldRenderer.tsx` | 删掉 `.filter(group => group.fields.length > 0 \|\| section.heading === '输入区')` 里的 `\|\| …` 那一半（★ 停手条件 2 的处置，见「偏差」1） | 修改 |
| `src/components/settings/__tests__/settingsChromeState.test.ts` | 示例折叠键 `'cc.外观风格'` → `'cc.输入框本体'`（§3.5） | 修改 |
| `src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json` | 脚本重拍（**除时间戳外逐字节相同**） | 修改 |

### 字段归属替换（§3.1）：78 个字段，逐条机械推导

依据 = 定义表里 `members[].fields`（刀1 不变量已钉住"80 项每项恰好属于一个成员"）⇒ **无需人工判断**。
真值分布（改前标签 → 改后子部件）：

| 元件（新分区 h3） | 子部件（新组名） | 字段数 |
| --- | --- | --- |
| 中控本体背景板 | 中控本体面 | 9（原「基础」6 + 「外观风格」2 + `footerLayout`） |
| 输入栏 | 输入框本体 / 提示符 ❯ / 上下两条线 / 历史快捷提示 | 28 / 1 / 3 / 1 = 33 |
| 模型 | 模型触发器 | 7 |
| 思考强度 | 思考强度触发器 | 7 |
| 权限模式 | 权限触发器 | 9 |
| 用量 | 用量胶囊 | 2 |
| 命令行提示 | 提示行 | 2 |
| 发送按钮 | 按钮本体 / 图标层 | 5 / 4 = 9 |
| **合计** | 12 个有字段的子部件 | **78** |

★ **三个 hidden 字段保持无分组**：`ccLayout` / `ccHidden` / **`ccEditMode`**。
施工单 §3.1 只点了前两个；第三个（`ccEditMode`，`hidden + meta`）也本来就无分组、不参与渲染
⇒ 实际"无归属"的是**三个**，不是两个。三者都 `hidden`，故不影响"可渲染集合"。

## 方案要点

1. **真值方向只能一条**：用户口径是"归属放在字段"⇒ 派生必须在**能同时看见两边的那一侧**
   （`themeFieldDefs.ts`）。定义表**不能**自己算 `fields`：那要它运行时 import `themeFieldDefs.ts`，
   正是该表表头写明的「头号雷」（成环、症状静默）⇒ 因此**删掉**表里那份手写清单，而不是让它反过来依赖字段表。
   依赖方向仍是单向：`themeFieldDefs` →（`ccHeightState` 间接 + 直接）→ `widgetDefinitions`。
2. **`GROUP_ORDER.cc` 的形状**：每个元件一个分区（`heading` = 元件 label），`groups` = 该元件下
   **有可调项**的子部件 label（顺序同表）。空子部件**在派生处就滤掉** —— 这样既满足"不渲染空标题"，
   也满足既有的 `settingsTraceability`「GROUP_ORDER 不得有空组」不变量。
3. **两个空标题的消失方式**：不再维护"手写一组、留俩空壳"，而是**派生压根不产生它们**
   （「附件按钮」「其他指示元素」在定义表里没有对应行）。
4. **`cc-surface` 不拆**：按用户口径，`中控本体面` 一个子部件名下 9 项（含 `ccVariant`，其存废由刀8 处理）。
5. **不变量怎么钉**（§4-2，本刀最关键的一条）：设置页是**按字段身上的 `group` 找组**渲染的，
   归属写错 ⇒ 那个项**凭空消失且不报错**。故新测试分三层：① 冻结的 78 项可渲染集合逐条相同；
   ② 每个**非隐藏** cc 字段的 `group` 必须是某个子部件 label（这一条遍历"全部"而非"可渲染的"，
   否则写坏的那个字段自己会掉出集合、反而漏检）；③ 分组表与定义表逐条一致 + 无空分区 + 空子部件不进表。
   ★ 另外：既有的 `settingsTraceability.test.ts`（**不是我加的**）本来就断言"每个非隐藏字段的 group 必须在
   `GROUP_ORDER` 里"⇒ 反向验证时它**也**红了（两道独立的守卫）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 门禁五步 | ✅ `lint`（0 error，唯一 warning 在他人文件 `RightRailHost.tsx`）/ `build:example-plugin` / `build` / `check:solid` / `test` 全绿 |
| 全量测试对账 | ✅ **628 文件 / 4758 通过 + 1 todo**（上一刀 627 / 4752+1 ⇒ **+1 文件 / +6 用例** = 新增的 `ccSettingsGrouping.test.ts` 6 条） |
| CSS 消费审计 | ✅ 注入 113 / 消费 348 / 声明 353 / 死注入 0 / 悬空引用 0（本刀不碰 CSS，与改造前逐项相同） |
| ★★ 字段集合不变量 | ✅ 冻结的 **78 项**可渲染集合逐一相同（`toEqual` 通过）；新增测试 6/6 绿 |
| ★ 实机 · 大标题前后各一次 | ✅ 改前 = `中控台 / 输入区 / 发送按钮 / 模型控件 / 思考强度控件 / 权限控件 / 附件按钮 / 其他指示元素`；改后 = `中控台 / 中控本体背景板 / 输入栏 / 模型 / 思考强度 / 权限模式 / 用量 / 命令行提示 / 发送按钮`（**按元件**） |
| ★ 实机 · 项一个不少 | ✅ **`.set-row` 总数：改前 78 → 改后 78**（逐条对上） |
| ★ 实机 · 抽查三项 | ✅ 输入背景（`输入与状态` → **输入框本体**，值 `#000000` 不变）/ 命令行边框宽度（`输入与状态` → **上下两条线**，值 `2` 不变）/ 显示历史快捷提示（`控件样式` → **历史快捷提示**） |
| ★ 实机 · 没有空标题 | ✅ 改前 `附件按钮`/`其他指示元素` 两个 h3 在 DOM 里；改后**两者均 false** |
| ★ 实机 · 搜索仍可用 | ✅ 输入「历史快捷」⇒ 只剩一个组 `历史快捷提示` + 一行 `显示历史快捷提示` |
| 契约快照 | ✅ 除 `generatedAt` 外**逐字节相同**（本刀不动任何字段值） |
| 反向验证 | ✅ 把某字段 group 写成不存在的子部件名 ⇒ 新不变量 **2 条红** + 既有 `settingsTraceability` **1 条红**；还原后全绿（见「证据」⑥） |
| 开发记录 / 总表 / issue 回写 | ✅ 本文件 + 仓外《中控元件总表》 + #238 评论 |

## 测试处置

**新增 1 文件 / 6 用例**（`ccSettingsGrouping.test.ts`）；**修改 2 个既有测试文件、未删任何用例**：

| 文件 | 改了什么 | 为什么 |
| --- | --- | --- |
| `src/domains/cc/__tests__/widgetDefinitionTable.test.ts` | 4 处 `member.fields` → `fieldsOf(member)`（读 `CC_MEMBER_FIELDS`）；「成员 ↔ 字段的归属逐条锁定」由数组 `toEqual` 改成**集合比对** | §3.3 的**必然连带**：`members[].fields` 这个属性已删，读它编译不过。集合比对的理由见「偏差」2（顺序不是契约，内容仍是） |
| `src/components/settings/__tests__/settingsChromeState.test.ts` | 示例折叠键换成新组名 `'cc.输入框本体'` | §3.5 点名 |

## 证据

- **commit**：`f064d6ce`（7 文件）；`git status` 干净；**未 push、未开 PR**。
- **① 门禁五步**：

  ```
  lint                 → ✖ 1 problem (0 errors, 1 warning)   # 警告在 right-panel/RightRailHost.tsx（他人文件）  EXIT=0
  build:example-plugin → EXIT=0
  build                → EXIT=0
  check:solid          → EXIT=0；CSS 消费审计通过（注入 113 / 消费 348 / 声明 353，死注入与悬空引用均为 0）
  test                 → Test Files 628 passed (628) | Tests 4758 passed | 1 todo (4759)   EXIT=0
  ```
  **对账**：上一刀终点 627 / 4752+1 ⇒ 本刀 **+1 文件 +6 用例**（新不变量测试），其余为断言/基线同步，用例数不变。
- **② 字段归属的机械替换（可复核）**：替换后逐字段核对「`def.group` == 它所属成员的 label」——
  **不一致项 = []**；**无归属项 = `['ccLayout','ccHidden','ccEditMode']`**（恰为三个 hidden 字段）。
- **③ 契约快照 diff**：

  ```
  diff <(去 generatedAt 的改前) <(去 generatedAt 的改后)   → 无输出（逐字节相同）
  git diff -- __fixtures__ | grep 增删行                  → 只有 1 行 generatedAt
  ```
- **④ 实机 · 改造前后（普通 `cargo build` 二进制 + 调试端点；A/B 两次构建，同一份 localStorage）**：

  ```
  BEFORE（HEAD~1 源码重建）
    h3 标题: 中控台 / 输入区 / 发送按钮 / 模型控件 / 思考强度控件 / 权限控件 / 附件按钮 / 其他指示元素
    组(行数): 基础6 / 输入栏17 / 发送按钮8 / 模型控件7 / 思考强度控件7 / 权限控件7 /
              外观风格2 / 控件样式12 / 输入与状态10 / 波形与用量2
    .set-row 总数 = 78        （另有两个非字段组：局部预设 / 布局编辑）
    「附件按钮」在 DOM = true ; 「其他指示元素」在 DOM = true
    抽查: 输入背景 [输入与状态] #000000 ; 命令行边框宽度 [输入与状态] 2 ; 显示历史快捷提示 [控件样式]

  AFTER（本刀源码重建）
    h3 标题: 中控台 / 中控本体背景板 / 输入栏 / 模型 / 思考强度 / 权限模式 / 用量 / 命令行提示 / 发送按钮
    组(行数): 中控本体面9 / 输入框本体28 / 提示符 ❯1 / 上下两条线3 / 历史快捷提示1 /
              模型触发器7 / 思考强度触发器7 / 权限触发器9 / 用量胶囊2 / 提示行2 / 按钮本体5 / 图标层4
    .set-row 总数 = 78        ← ★ 与改前**逐数相同**（"一个项都没丢"）
    「附件按钮」= false ; 「其他指示元素」= false   ← ★ 两个空标题消失
    抽查: 输入背景 [输入框本体] #000000 ; 命令行边框宽度 [上下两条线] 2 ; 显示历史快捷提示 [历史快捷提示]
    搜索「历史快捷」⇒ 只剩 1 组(历史快捷提示) + 1 行(显示历史快捷提示)
  分组合计校验：9+28+1+3+1+7+7+9+2+2+5+4 = 78（= 旧 6+17+8+7+7+7+2+12+10+2）
  截图: C:\Users\Elysita\.zcode\cli\artifacts\sess_eeecd554-9323-4a31-971b-5013fc84743a\
        call_00_ET_9Hu5oaNmV6uy9khIupz93492-tool-result-7df7c6a5-0084-4c52-adda-3e5c6b5fbdac.png
        （左：设置导航「中控台」下已换成子部件名；右上：h3「中控本体背景板」+ 组「中控本体面」+ 各行；无空标题）
  ```
  ★ 实机顺带记录两点（都**不是**本刀引入）：
  - 设置**左侧导航**的二级项也从 `GROUP_ORDER` 派生（`SettingsSheetSidebar.tsx:66`），
    故那里的 cc 二级项**一并变成子部件名**（扁平列出，不按元件再分一层）—— 属"二级项 = 组标题"的既有口径。
  - `显示历史快捷提示` 那个下拉显示成 `true（已不可用）`：该字段**默认值是布尔 `true`** 而选项是
    `'shown'/'hidden'`（存量数据也是布尔 `true`）⇒ 选项匹配不上。**与本刀无关**（本刀不碰类型/默认值/归一化），
    仅如实记录，未处理（单子没点名）。
- **⑤ 无空标题的另一重确认**：改后只剩两个非字段组（`局部预设` / `布局编辑`），与改前**相同**（那是
  Settings 手写的固定块，不是本刀的分组）；没有可调项的子部件（命令菜单 / 输入预测 / 待发送队列 / 报错条 /
  空态插槽 / 各菜单）**一个都没进列表**（由新测试逐条钉住）。
- **⑥ 反向验证（贴红→绿）**：把 `inputShowHistoryHint` 的 group 故意写成 `"历史提示"`（不存在的子部件名）：

  ```
  FAIL  ccSettingsGrouping > ★ 可渲染的 cc 字段集合与改造前逐条相同（多一项/少一项都是红的）
  AssertionError: 中控区的项在设置页里凭空增减了 —— 归属被写坏:
    expected [ 'ccBg', 'ccBgImage', …(75) ] to deeply equal [ 'ccBg', 'ccBgImage', …(76) ]
  FAIL  ccSettingsGrouping > 每个非隐藏 cc 字段的 group 恰好等于某个子部件的 label
  AssertionError: 以下字段的归属值不是子部件名：
    inputShowHistoryHint → group="历史提示" 不是任何子部件的名字
  FAIL  settingsTraceability > every non-hidden field is reachable from its zone group order
  AssertionError: 不可达字段（zone+group 无 UI 归属）: inputShowHistoryHint (zone=cc, group=历史提示)
  Test Files 2 failed | Tests 2 failed | 4 passed（ccSettingsGrouping 单跑）
  ```
  还原后：`Test Files 2 passed (2) | Tests 10 passed (10)`（新测试 6 + settingsTraceability 4）。
  ⇒ 不变量**不是空的**：写坏一个归属，两道独立守卫同时变红。

## 与 spec 的偏差

1. **停手条件 2 的处置（一处清单外的"依赖旧 cc 分组字面量"）**：全局搜旧 cc 标签时发现
   `src/themeFieldRenderer.tsx` 的组过滤里有一条 `|| section.heading === '输入区'` 特例 ——
   它是给手写时代的「输入区」保留占位小标题用的。cc 分组改派生后**全仓再无 heading 叫「输入区」的分区**
   ⇒ 该特例成为死代码。按停手条件 2 的括注（"一起纳入，别漏"）**一并删掉**（`themeFieldRenderer.tsx` 一处）。
   ★ 其余旧标签的字面量出现在注释/元件名/无关文案里（如「模型控件常态显示」这种描述**控件**的句子），
   **不是**分组依赖，未动。
2. **`members[].fields` 的删除方式与 §3.3 的字面表述不同**：§3.3 写"由 `THEME_FIELD_KEYS.filter(...)` 算出
   （保持类型形状不变）"。若"算出"发生在**定义表内**，就必须让定义表运行时 import `themeFieldDefs.ts`
   —— 那正是 §5-4 要停手的**成环**（也是该表表头写明的头号雷）。
   ⇒ 落地方案：派生放在 `themeFieldDefs.ts`（`CC_MEMBER_FIELDS`），定义表那边**删掉** `fields`
   （类型栏位一起删，换成指向新真值的注释）。**"成员还带一个字段清单"的对外形状由派生视图保持**；
   代价是 `CcWidgetMember` 少了一个栏位（规范 §4.3 的"成员每行承载字段清单"改由派生承接），
   以及下面第 3 条那个测试连带。
3. **`widgetDefinitionTable.test.ts` 是§3.3 的必然连带**（单子未点名它）：它 4 处读 `member.fields`，
   删栏位后**编译不过**，只能改成读派生视图。其中"归属逐条锁定"那条由数组比对改成**集合比对**：
   派生列表的顺序 = 字段在 `themeFieldDefs.ts` 里的**定义顺序**，与旧手写顺序不同；
   "谁拥有哪些字段"才是那条断言的契约（成员内部顺序由 `THEME_FIELD_KEYS` 决定、另有渲染逻辑），
   故按集合比对，并在注释里写明原因。**未删除任何用例**。
4. **施工单 §3.1 少点了一个 hidden 字段**：除 `ccLayout`/`ccHidden`，`ccEditMode` 同样无分组且 `hidden`
   （它是 meta 字段）。三者都不参与渲染，故不影响不变量；记录在此以免后来者对账时以为漏了一个。
5. **一个意外收获**：既有的 `settingsTraceability.test.ts` 已经断言"每个非隐藏字段的 group 必须在 `GROUP_ORDER` 里"
   —— 本刀要的防护**部分已存在**（所以反向验证时它也红了）。新测试的价值在于**冻结集合**这一层
   （防的是"某个字段的所有者可被删掉/整片搬家"这类既有测试抓不到的错），两者互补。

## 未解问题

1. **用户已存的"折叠记忆"会失效**（施工单 §3.5 要求声明的副作用）：折叠状态按 `cc.<组名>` 存
   （`pylon-settings-collapse`）⇒ 组名从旧标签换成子部件名后，旧键对不上新组，**该区回到默认展开**。
   数据不坏，只是要多点一下。★ **实测：本机这台根本没有这个键**（`localStorage['pylon-settings-collapse']` = `null`）
   ⇒ 对当前用户**没有实际影响**；但换到别的机器上会生效，如实登记（单子已允许）。
2. **设置左侧导航的 cc 二级项现在是子部件名（扁平）**：`SettingsSheetSidebar` 从 `GROUP_ORDER[zone]`
   扁平派生二级项，故「中控台」下有 12 个子部件名（中控本体面 / 输入框本体 / 提示符 ❯ / …）。
   **是否要在导航里也体现"元件 → 子部件"两层**，属设置页 IA 的另一件事（单子只要求设置页正文分两级，
   §2 的目标形状也只画了正文）⇒ **本刀不动**，供后续决定。
3. `显示历史快捷提示`（`inputShowHistoryHint`）的选项匹配不上存量布尔值（显示 `true（已不可用）`）——
   **先于本刀存在**，单子未点名 ⇒ **未处理**，仅记录（真要修是"默认值与选项类型不一致"的另一件事）。

## 并行交集

- 中控区：`src/themeFieldDefs.ts`、`src/domains/cc/widgetDefinitions.ts`、`src/themeFieldRenderer.tsx`、
  `src/domains/cc/__tests__/{widgetDefinitionTable,ccSettingsGrouping}.test.ts`、
  `src/components/settings/__tests__/settingsChromeState.test.ts`。
- 快照：`__fixtures__/workbench-skin-baseline.json`（**只能脚本重拍**；本刀零差异）。
- ★ **与刀8（删掉整体风格）冲突**：两刀都改 `src/themeFieldDefs.ts` 与出厂数据 ⇒ **不并行**，本刀先做、已收口。
  （注：本刀**未**改出厂数据 —— `def.group` 不进出厂数据；`ccVariant` 的归属本刀已落在「中控本体面」名下。）
- 仓外文档已同步：《中控元件总表》。
