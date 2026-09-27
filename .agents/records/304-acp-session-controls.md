# #304 ACP 中控状态收敛开发记录

> 入库保留。规格文档 `.agents/spec/304-acp-session-controls.md`（不入库）的目标、范围与验收结论在此承接。

## 元信息

- **issue**：[#304](https://github.com/AlchemistCxC/Pylon-co-works/issues/304)（`bug(acp)`，承接 #266 CC-26，与已关闭 #97 的状态收敛契约相关）
- **分支**：`kumo/prometheus`（基线 `9883bb1d` + `github/main a9d4b979`）
- **提交范围**：`57db6335..8e24ce92`（`57db6335` 为合入 `github/main` 的 merge，`7ca04b09` 为 `L.md` 施工声明，`8e24ce92` 为实现提交；本记录随后单独提交）
- **日期**：2026-09-24
- **署名**：实现 = Codex（本轮之前的在途改动）；收尾 = Miyaki Kumo（残留清理、文档同步、门禁复跑与记录撰写）
- **性质**：bug 修复 + 契约收敛（跨 Rust 控制层 / ACP 契约解析 / Workbench 会话层 / 中控渲染层）

---

## 1. 目标与范围

**要达成什么**——中控的模型、权限模式、上下文用量三条链路，一律以 **Agent 宣告**与**权威回包**为准：按宣告的 ID/value 切换，回包里有什么就更新什么，回包没说的不伪造权威值；旧 `modes`/`models` 面继续兼容。

**不做什么**——不改视觉布局与几何、不改持久化 schema、不动 provider 凭证、不动预设系统；**本轮不做实机验收**（用户 2026-09-24 指示）；插件命令执行器的 `/mode`、`/model` 不并入本次（见 §8 未解问题 2）。

---

## 2. 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/session/control.rs` | `set_mode` 改为「先读宣告再选通道」并返回收敛结果；两条 `set_config_option` 通道换 generation 校验 RPC；回包 `configOptions` 入 journal | 修改 |
| `src-tauri/src/session/model.rs` | `SessionInfo` 新增 `mode_choices`（legacy modes 宣告面与标准 configOptions 分离）；`apply_session_response` 中标准 option 优先于 legacy 状态；分组 choices 递归展开；`config_option_identity` 提为 crate 可见 | 修改 |
| `src-tauri/src/session/create.rs` | 新增 `response_projection_options`（legacy 目录只做 journal 投影，带 `_meta.pylonLegacySelector`）；建立期/恢复期两处改用它 | 修改 |
| `src-tauri/src/session/persist.rs` | load 响应投影改用 `response_projection_options` | 修改 |
| `src-tauri/src/session/model_switch_wire_tests.rs` | 新增 mode 的 wire 断言用例 | 修改 |
| `src/components/chat/sessionModeState.ts` | 废除 mode 发送白名单，ID 原样透传；移除死代码 `nextSessionMode`/`MODE_CYCLE` | 修改 |
| `src/infrastructure/acp/chatContracts.ts` | `extractConfigOptionChoices` 分组递归；`extractModelConfig`/`extractModeConfig` 让标准 option 压过 legacy 状态与目录 | 修改 |
| `src/sheets/agent-workbench/agentWorkbenchSession.ts` | 新增 `runSessionControl` 单一控制边界；去重语义由「累积集合」改为「最近一条 + session 快照」；selector-pending 状态键 | 修改 |
| `src/sheets/agent-workbench/sessionResponseProjection.ts` | 有标准 option 时不再合成 legacy model/mode 候选；事件 id 含 sequence；新增 `session.config-updated` 事件种 | 修改 |
| `src/sheets/agent-workbench/AgentRendererSuiteWorkbench.tsx` | 三个选择器写入改走 `runSessionControl`；非字符串/布尔的 config 值显式拒绝 | 修改 |
| `src/renderers/solid-workbench/input/ControlCenter.solid.tsx` | 用量控件改消费 `resolveContextUsage`（used/limit/percent），未知值显示 `—`；渲染 selector-pending 状态行；删除本地 `usageTokenCount`/`contextRatio` | 修改 |
| `src/renderers/solid-workbench/input/workbenchOptionCatalog.ts` | `optionKind` 改 category 优先（`model_config` 不再误判为 model）；mode 兜底表只在空态（无 session）使用 | 修改 |
| `src/domains/workbench/sessionUiStore.ts` | 新增 `selector-pending` 键 | 修改 |
| `src/plugins/core/commandSet/builtinCommands.ts` | `/mode`、`/model` 的 `inputHint` 与 `agentPromptSnippet` 去掉已废词表（`default\|edit\|auto\|bypass`、`<name>`） | 修改 |
| 5 个既有测试文件 | 契约断言与 fixture 跟随（逐项见 §6） | 修改 |
| `src/sheets/agent-workbench/__tests__/sessionControl.test.ts` | 新增：控制边界 6 用例 | 新增 |
| `docs/说明书/Pylon-模块维护地图.md` | sessionResponseProjection 一行：去重语义与投影规则同步（防漂移） | 修改 |

规模：20 个路径，`403+ / 159-`（不含新增测试 89 行）。

---

## 3. 方案要点

1. **mode 是 opaque ID**：前端 `normalizeSessionMode` 只要求「非空字符串」，不再翻译 `edit → accept_edit`，也不再拿白名单拒绝 Agent 宣告的 `acceptEdits`/`plan`/`bypassPermissions`。
2. **后端按宣告选通道**（`control.rs::set_mode`）：会话宣告了 `category=="mode"` 的标准 config option ⇒ 先校验目标值 ∈ 宣告 choices（`mode_not_advertised`），再以**宣告的 configId** 走 `session/set_config_option`；只有 legacy `modes.availableModes` ⇒ 校验后走 `session/set_mode`；两者皆无 ⇒ `mode_switching_unavailable`。legacy 通道的回包固定为 `{"modes":{"currentModeId": mode}}`——只承认被请求的这个维度，不伪造候选表。
3. **回包即权威**（`agentWorkbenchSession.runSessionControl`）：回包带 `configOptions` 时整份作为文档事件投影（含被钳制的模型与依赖项目录）；否则只发布确认到的 model/mode。回包里读不到值、且期间没有通知改动过选择器 ⇒ 写 `selector-pending`「X（等待 Agent 确认）」，**不把 requested 冒充 confirmed**（ADR-0004 方案 C 的 pending 态）。
4. **写入单一入口 + 隔离**：`selector_owner_stale`（owner/source 不匹配）、`selector_request_in_flight`（并发写拒绝）、请求期 generation/session 比对（切 owner 后迟到回包丢弃）。
5. **去重语义修正**：`appliedSessionResponseKeys` 由只增不减的 `Set` 改为「最近一条 `{key, session}`」——旧实现让 A→B→A 的第二段被永久吞掉。
6. **分组 select 递归**：`{group, options:[…]}` 不再被当作候选（组名曾冒充 choice id）。
7. **投影与出站分离**：`response_projection_options` 保留 legacy 目录供 journal 重放（重启后中控恢复候选），并显式标注「不得据此推断出站 ACP 方法」。
8. **用量**：ACP `usage_update` 的 `used`/`size` 早已由 `acpNormalizer` 映射为 `contextUsed`/`contextLimit`；本次只把消费端从「本地推算 totalTokens/比例」改为与消息卡同源的 `resolveContextUsage`，未知一律 `—`。

---

## 4. 验收标准与结果

| 验收项（源：spec §验收） | 结果 |
| --- | --- |
| 官方 grouped fixture 递归展开 | ✅ 通过（Rust `grouped_acp_choices_are_values_not_group_labels`；前端 sessionControl 首例） |
| Claude opaque modes（`plan`/`acceptEdits`/`bypassPermissions`） | ✅ 通过（`normalizeSessionMode` 原样放行 + 用例断言） |
| 真实 advertised configId 上 wire | ✅ 通过（wire 测试断言 `configId=permissions-choice`、`value=acceptEdits`） |
| 回包钳制与依赖目录变更 | ✅ 通过（「adopts the complete reply」例：模型被钳制、依赖 option 同步入档） |
| 空回声 | ✅ 通过（保持已确认态 + 目录不丢 + 可见 pending） |
| 往返选择 A→B→A | ✅ 通过（去重语义修正后第二段生效） |
| 切 owner 迟到回包 | ✅ 通过（丢弃且不留 pending） |
| 标准 `used`/`size` | ⚠️ 仅单测与单位核对（`acpNormalizer` 映射 + `resolveContextUsage` + `formatUsagePercent(percent/100)` 单位正确）；**未做实机数值验收** |
| 相关 Rust wire 测试与前端回归 | ✅ 通过（计数见 §7） |
| 完整门禁 | ✅ 通过（`check:frontend` + `check:solid` + Rust 段；`check:rust` 脚本因 G 盘写满需按 L.md 约定改 `CARGO_TARGET_DIR` 跑，见 §7） |
| 可用实机入口 | ❌ **未做**（用户明确本次不做实机验收） |

---

## 5. 测试处置（spec §测试处置要求「逐项记录」）

**契约变更跟随的既有断言**

1. `src/components/chat/__tests__/sessionModeState.test.ts`
   - `resolvePreviousSessionMode('edit')`：`'accept_edit'` → `'edit'`（ID 不再翻译）。
   - `normalizeSessionMode('edit')`：`'accept_edit'` → `'edit'`；原 `normalizeSessionMode('invalid') === null` 断言删除，改为 `'custom' → 'custom'`（opaque 放行）与 `'' → null`（空白拒绝）。
2. `src/infrastructure/acp/__tests__/chatContracts.test.ts` — 存在标准 model option 时 `models` 由 `['provider:a','provider:b']` 收敛为 `['provider:a']`、`modelChoices` 去掉无 label 的第二项：legacy `availableModels` 不再与标准 option 合并。
3. `src/renderers/solid-workbench/input/__tests__/workbenchOptionCatalog.test.ts` — 用例名「treats a candidate surface holding only the current mode as not advertised」→「preserves a singleton mode advertisement without inventing candidates」；断言由「回落 `DEFAULT_MODE_OPTIONS`」改为 `['auto']`。
4. `src/renderers/solid-workbench/input/__tests__/WorkbenchWidgets.solid.test.tsx` — 两处 fixture 的 `reasoning_effort.category` 由 `'mode'` 改为 `'thought_level'`：`optionKind` 改为 category 优先后，fixture 必须写对 category。

**新增**

5. `src/sheets/agent-workbench/__tests__/sessionControl.test.ts`（新文件，6 用例）：opaque mode ID 保留 + 标准 option 压过冲突 legacy 状态 + 分组展开；完整回包采纳（钳制模型 + 依赖项）；A→B→A 与空回声 pending；切 owner 迟到回包丢弃；RPC 期间通知不丢依赖项；并发写拒绝 + RPC 失败保持原态。
6. `src-tauri/src/session/model_switch_wire_tests.rs::mode_uses_advertised_config_id_and_validates_before_wire`：断言发的是 `session/set_config_option` + 宣告 configId、未宣告值不上 wire、全程不发 `session/set_mode`。
7. `src-tauri/src/session/model.rs`：`grouped_acp_choices_are_values_not_group_labels`、`legacy_selector_projection_preserves_catalogue_without_changing_rpc_surface`。

**本轮收尾删除**

8. `sessionModeState.test.ts` 的「`nextSessionMode` 轮换：default→accept_edit→auto→bypass→default」用例与边界用例里的 `nextSessionMode('unknown')` 断言——随死代码 `nextSessionMode`/`MODE_CYCLE` 一并移除（全仓无产品调用点，只有该测试引用）；对应 describe 标题由「session mode 轮换与 ACP usage 提取」改为「会话 mode 状态与 ACP usage 提取」。

**未改动**：`resolveContextUsage` 及用量投影的既有用例（改动只换了消费端）；`extractUsage` 读标准 `used`/`size` 的既有断言。

---

## 6. 证据

- **commit**：`7ca04b09`（`L.md` 声明，单文件 pathspec）；`8e24ce92`（实现，20 路径 pathspec，`492+ / 159-`）。
- **门禁**（全部在含本改动的树上实跑）：
  - `bun run check:frontend` → exit 0（含 `lint`、`check:csp`、`check:canonical-types`、`check:ipc`、首方样式、Tailwind token、example-plugin/wasm 构建、`test`、`vite build`、`check:bundle`、solid-smoke、`check:docs`、`check:deps`、生产产物隔离）
  - `bun run test` → **641 文件通过 / 4857 用例通过**（1 skipped、1 todo），exit 0
  - `bun run check:solid` → exit 0（边界/CSS 消费/ZONE_FIELDS/插件清单/context panel/hook anchor 全通过）
  - Rust（`CARGO_TARGET_DIR=D:/pylon-acceptance-target`，见下）：`cargo test --workspace --lib` → **1352 passed / 0 failed / 4 ignored**；`cargo test session::` → 134 passed / 0 failed；`cargo build`（含 fake-agent）成功；`check:acp-shadow` 通过；`cargo fmt --all --check` **干净**
- **环境注意**：`bun run check:rust` 脚本自带 `cargo build`（不设 `CARGO_TARGET_DIR`），在本机因 **G 盘 100% 满**（`src-tauri/target` 已 29G）以 `os error 112 磁盘空间不足` 失败；按 L.md 既有约定把同一套命令的 `CARGO_TARGET_DIR` 指向 `D:/pylon-acceptance-target` 后全绿。这是环境问题、非代码问题，但会拦住所有直接跑 `check:rust` 的人。
- **本轮收尾修掉的门禁红灯**：`cargo fmt --check` 原先在 `control.rs`（2 处）与 `model.rs`（1 处）报格式不合规，已 rustfmt 修正（只格式化这两个 #304 文件）。
- **手工验证**：无（用户指示不做实机验收）。

---

## 7. 与 spec 的偏差

- **spec 未列而本轮做了**：`builtinCommands.ts` 的 `/mode`、`/model` 提示与 prompt 文案（旧词表残留）；`sessionModeState.ts` 死代码 `nextSessionMode`/`MODE_CYCLE` 移除；`docs/说明书/Pylon-模块维护地图.md` 一行去重表述同步。
- **spec 的「无新增产品方向决策」与实际不符**：mode 轴在「既无标准 option 又无 legacy 宣告」时由 ADR-0004 规则 3 的 fail-open（放行）改为 fail-closed（`mode_switching_unavailable`），且 mode 现在按宣告 configId 上 wire 而非「语义键直发」。这两点 ADR 未覆盖，**未登记 ADR**（依 §2.3.3，等用户裁断后再登记；见 §8-1）。
- **spec 写了没做**：实机验收（用户 2026-09-24 指示本轮不做）。
- **spec 的「测试处置逐项记录」**由本记录 §5 承接。

---

## 8. 未解问题

1. **ADR-0004 规则 3 与 mode fail-closed 的分歧需裁断**。ADR 对非 model 语义键写明「choices 为空（未宣告）时放行」，而本实现改为硬拒。它镜像了 model 轴既有先例（`resolve_model_switch_target` 的 `surface == None` → 报错），内部自洽，也符合 #304「不伪造」的取向，但属于新决定：**需要用户裁断后补 ADR 修订，或者在 ADR 里明确这是 ACP 对齐的例外**。
2. **`/mode`、`/model` 的插件命令执行器仍走重构前通道**：`src/plugins/core/commandSet/builtinCommandExecutors.ts` 的 `model`/`mode` 直接调 `setSessionModel`/`setSessionMode`（写 `useRuntimeStore` + 裸 RPC），绕过 `runSessionControl`，因而没有 owner/generation 守卫、没有 pending 态、也不消费权威回包。输入栏的 `/model`、`/mode` 与中控控件**已覆盖**（走 `workbench.commands` → 渲染层覆盖 → `runSessionControl`），此路径是 agent/CLI 工具面。并入需要把会话控制边界引入插件层（新架构），建议另开 issue。同类潜伏：`agentWorkbenchCommands.ts` 的 `productionDependencies` 默认实现仍是旧路径（当前总被渲染层覆盖）。
3. **mode 菜单在「宣告 ≤1 个 mode」时为空盒**：`WorkbenchWidgets.solid.tsx` 的菜单渲染会过滤掉当前值，而兜底表现在只在空态使用。这与「不伪造候选」（model 轴既有先例同款）一致，且这类会话本就没有可切换目标，但空 listbox 没有兜底提示。**注意这是对 #156 决策（`advertisedChoices`：只有当前值 ⇒ 回落兜底表）在 mode 轴上的反向**——换了取舍方向，值得让后续 UI 决策知道。
4. **未做实机验收**：本记录全部证据来自单测、wire 测试与门禁；`usage_update` 的真实数值显示、Hermes/CCB 上的实际 mode 切换未在真实进程里验证过。
5. **G 盘 100% 满**：会拦住任何未设 `CARGO_TARGET_DIR` 的 cargo 调用（含 `check:rust` 脚本本身）；`src-tauri/target` 29G 是既有产物，本轮未删。

---

## 9. 并行交集

本轮碰过的共享文件（供其他贡献者避让）：`src-tauri/src/session/**`（5 文件）、`src/components/chat/sessionModeState.ts`、`src/infrastructure/acp/chatContracts.ts`、`src/domains/workbench/sessionUiStore.ts`、`src/renderers/solid-workbench/input/{ControlCenter.solid.tsx,workbenchOptionCatalog.ts}`、`src/sheets/agent-workbench/**`、`src/plugins/core/commandSet/builtinCommands.ts`、`docs/说明书/Pylon-模块维护地图.md`、`.agents/L.md`。

`.agents/L.md` 的 #304 条目**保留至合入**后移除。
