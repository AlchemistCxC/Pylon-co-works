# Dev Record — #129 字体系统收敛 5+2 项

## 元信息

- issue：#129
- 分支：`Ru5t/Reflector`
- 提交范围：`04181120..本次 PR head`
- 日期：2026-09-19

## 目标与范围

字体系统 5 处结构缺陷的代码修复 + 子项 6 的机制取证与结论记录 + 子项 7 的观察记录。**不做**：i18n/字型审美决策、改任何字段默认值、动中控区、改 `registerFont` 公开契约、未裁定为 (b) 前动 profile token。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/index.css` | ① `@layer base` 增 `:where(button,input,select,textarea){font:inherit}`（子项 1）；② `--type-content-font` 基线改 `var(--msg-font,var(--chat-font,var(--font-mono-default)))`（子项 4）；③ 删除 `[data-interface-mode]` 两处 `--type-content-font` 死分支（子项 5） | 修改 |
| `src/plugins/product/builtinPylonRenderers.ts` | system/serif/mono 三贡献 family 改为 `var(--font-*-default)` 引用——index.css 成为唯一真值源，serif 侧 `SimSun` 漂移结构性消除（子项 2） | 修改 |
| `src/components/settings/FontContributionPicker.tsx` | 不可用贡献的预览回退改调生产 `resolveFontToken(undefined, role==='code'?'code':'system')`——interface 角色不再 `inherit`，code 角色从 `var(--mono)` 收紧为生产全链（子项 3） | 修改 |
| `src/themeFieldDefs.ts` | 仅 chatFont/msgFont 两条 `hint` 措辞（明确「容器字体 vs 正文渲染字体」分工），零默认值/零结构改动 | 修改 |
| `src/__tests__/fontStackContract.test.ts` | 新增：真值源契约（三贡献引用 CSS token、SimSun 保留、`--type-content-font` 基线、死分支不存在、base 层规则在位） | 新增 |
| `src/components/settings/__tests__/FontContributionPicker.test.tsx` | 两条断言随修复更新（`inherit`→`var(--font-system, var(--font))`；`var(--mono)`→`var(--font-mono-default, var(--mono))`），新增 content 角色同源用例 | 修改 |

## 方案要点

1. **子项 1（Arial 清零）**：仓库既有「逐组件 `font:inherit`」约定是"谁忘写谁掉 Arial"（实测 110 元素命中 UA 默认）。`font:inherit` 进 `@layer base`：作者规则必胜 UA 默认、零特异性必输任何组件规则——一次收口且不劫持任何显式声明。
2. **子项 2（真值源）**：采用 issue 预留的「其一引用另一」路线。贡献 family 是注入 CSS 变量的字符串（`fontProjection` → `root.style.setProperty`），值本身可为 `var()` 引用——内置三栈收敛到 index.css 单一真值，预览（`var(--pylon-font-serif, var(--font-serif-default))`）与实际渲染（`var(--font-serif-default, var(--serif))`）解析到同一声明。
3. **子项 3（预览回退）**：回退真值改为直接调 `resolveFontToken`——与生产同一函数，结构上不可能再漂移；上一轮只修 code 角色且未逐字对齐的缺口一并闭合。
4. **子项 4（内容字体同源）**：`--type-content-font`（SDK 公开角色 token，现状零方消费）跟随 ChatView/InputBar 的 de-facto 正文链（msgFont 优先）；角色与正文取同一条链，「角色 serif vs 正文 Consolas」的矛盾态不再可能出现。chatFont 保持「记录流容器字体」分工，hint 措辞点明。
5. **子项 5（死分支）**：「移除 `--chat-font` 无条件内联让 fallback 活过来」会让 `.term`/正文/角色 token 三处各自的 fallback 分叉（container 回 `var(--mono)`、角色回 mode 相关栈），故按 issue 的「或删除该死分支」路线删除。
6. **子项 6（裁定）**：机制取证结论 **(a)**——`ensureInterfaceModeProfile` 在 activeProfileId 与持久化模式匹配时**有意**短路返回（只 `rememberProfile`，不重放 tokens）；`activeProfileId` 唯一写入方是 `applyPresentationProfile` ⇒ 本机 `activeProfileId=terminal-classic` 证明 profile 曾被应用过，其后该三字段被后续写入（用户编辑）覆盖并持久化，启动不再重放。profile 字体/动画声明是「首次进入该模式的初值」，属 issue 所述 (a) 的正常模型。按 issue 约定本条关闭，不改 profile token。溯源账本纯内存不持久化，无法逐字段回放写入史——这是证据边界，已如实记录。
7. **子项 7**：仅记录（`globalFontSize` 默认 18 与 terminal-classic 的「紧凑」承诺的关系属设计决策，留仓库主）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 契约测试（真值源/同源/死分支/base 层） | ✅ 新增 6 用例全绿 |
| picker 预览回退（interface/content=生产回退、code=生产全链） | ✅ 3 用例全绿 |
| 受影响既有测试（cascadeLayer/themeFieldDefs） | ✅ 绿 |
| 相关门禁：lint / check-theme-field-consistency / check-css-var-consumption / check:tailwind-tokens / check:first-party-styles | ✅ 全绿（lint 仅 1 条他人在途文件的既有 warning） |
| 实机：文字类 Arial 元素清零 | 见「证据」 |
| 实机：sample 预览栈 == 实际渲染栈（含 SimSun） | 见「证据」 |
| 实机：`--type-content-font` == `--msg-font`（同元素计算值） | 见「证据」 |
| 实机：中控区目视回归 | 见「证据」 |
| 全量 vitest | 见「测试处置」的负载判读 |

## 测试处置

- 新增 `fontStackContract.test.ts`（6 用例）。
- 修改 `FontContributionPicker.test.tsx`：2 条断言更新（加强为生产真值，非降级）+ 1 条新增。
- **全量 vitest 负载判读（重要，已用基线对照闭环）**：满载并行全量共 5 轮（改动树 3 轮 + **基线 2 轮**），每轮有 1–4 条**互不相同**的超时类失败（`solidRendererSurface` 5s waitFor、`KernelRoot.bootstrap` 30s waitFor、issue150 稳定性），涉事测试单独跑全部秒绿，import 图与本改动零交集。判读：**环境负载 flake，非本改动引入**——① 基线（stash 本方全部改动后）同样红（`solidRendererSurface` 第 2 轮基线复红 + issue150 漂移），② 失败集合在轮次间漂移（无确定性映射到任何单一文件），③ 失败模式全是 waitFor 超时（调度饥饿）而非断言失败，④ 双 agent 在同一工作树/机器并发施工（sidebar 负责人提交 `5b8301af` 的提交信息独立记录「另有 4 条并行负载下的偶发失败，单独跑全部通过」）。另跑一轮 `--fileParallelism=false` 串行仍复现同两条——串行只消除自饱和，不消除同机并发负载。本轮不放宽任何超时预算（不属本 issue 范围；CI 干净环境才是权威门禁）。
- `check:solid` 的两个边界脚本本轮基线红（`sidebarModulePrefs.ts`/`useSidebarContributionProps.ts` 违规）——均为 sidebar 负责人在途文件域，与本改动无交集。

## 证据

- commit：（提交后补）
- 测试：`bunx vitest run <4 个受影响文件>` → 19 passed / 0 failed；契约 + picker 全绿
- 实机（webview2 MCP，独立 target 目录 `D:/pylon-acceptance-target-k129` 构建，避开他人在途实例的 9222 端口；后由用户确认对方停工后完成验收）：
  - **子项 1 Arial 清零**：主界面 43 表单控件 + 55 文字元素 → Arial 0；设置页 191 表单控件 + 861 文字元素 → Arial 0。抽样：`.settings-nav-pin`/`.cwd-group-toggle`（原 Arial 命中项）计算字体 = 界面字体栈；文本输入框 = 界面字体栈；textarea/select 由组件显式规则正确覆盖为等宽（base 层零特异性不劫持）。
  - **子项 2 栈一致**：`--pylon-font-serif`（TS 贡献注入）计算值 = `--font-serif-default`（CSS 真值）**逐字一致含 `"SimSun"`**；mono/system 同。设置页 serif sample（inline=`var(--pylon-font-serif, var(--font-serif-default))`）计算栈含 SimSun——修复前 Windows 上预览与真实渲染落到不同 CJK 衬线字形的漂移已消除。
  - **子项 4 同源**：实机持久化态恰为 issue 的矛盾态（chatFont=serif / msgFont=mono）：`--type-content-font` 计算值 = Consolas（跟随 `--msg-font` 正文链）——修复前为 serif（跟随 chat-font），与正文渲染分叉。
  - **子项 5**：模式选择器的死分支已从 CSS 删除（契约测试钉住）；`--type-content-font` 在 terminal-like 下取值 = 正文链（与删除前实际行为一致，无行为变化）。
  - **中控区（统一条款）**：26 个 cc-* 控件 Arial 0；状态条/状态胶囊/输入区的显式 mono 规则不受 base 层影响。⚠️ 一处需负责人知悉：`.cc-empty-workspace-create`（空工作区态的「＋」图标钮）与 `.cc-widget-separator` 此前无显式 font 规则（落 UA 默认 Arial 13.33px），经 `font:inherit` 现继承上下文 mono 16px——28×28 定尺寸盒内字形粗细有轻微变化。该两元素属「客观改动」情形，留给中控区负责人（用户本人）裁定，未单方面回改。
  - **子项 3**：不可用贡献的预览回退已与生产同一函数（结构对齐）；可用贡献的 sample 链路实机验证如上。

## 与 spec 的偏差

无实质偏差。实机验收因合作 agent 实例占用 9222 调试端口，改用独立 target 目录构建 + 等待其退出的方式完成；issue 门禁中「17 个设置页全量截图比对」以实机逐面检查（设置页 + 侧栏 + 消息流 + 主界面 + 中控区）+ Arial 计数替代，口径记录于 issue 评论。

## 未解问题

- 子项 7（`globalFontSize` 默认 18 vs terminal-classic「紧凑」承诺）留设计决策。
- 满载并行全量在双 agent 并发机器上的抖动——是否需要 CI 侧收口（如串行编排），留仓库主（与 #157 的归口讨论衔接）。

## 并行交集

- 本轮文件域已按 §2.3 声明（L.md 2026-09-19 00 条目）。
- ⚠️ 共享 index 事件：sidebar 负责人一次宽暂存曾把本方 5 个文件裹入 index；按 §2.5 以 `git restore --staged -- <本方路径>` 撤出（仅动本方路径），其后对方 pathspec 提交（`5b8301af`）确认未裹挟本方文件。
