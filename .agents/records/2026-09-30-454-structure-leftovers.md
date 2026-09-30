# #454 遗留清偿批（A-V2/V3/V4/V9/V12、B-2 豁免清偿、B-8 余项、B-12）· 开发记录

- 日期：2026-09-30
- 执行：[kumo]
- 性质：refactor（结构清偿为主；A-V2 属登记过的行为面收口，语义保序）
- 分支：`kumo/454-structure-leftovers`（独立 worktree `G:/Project/prism-team-workdir/pylon-454`，基于 github/main 8572cb02）
- 规格：`.agents/spec/454-structure-leftovers.md`（共享树，一次性不入库）
- 依据：`../Docs/Archive/frontend-structure-review-pr455/frontend-structure-review-{A-view,B-logic,R1,R2}.md` 与 #454 正文遗留清单

## 处置清单（按提交序）

| 提交 | 内容 | 对应遗留项 |
|---|---|---|
| `35758bb0` | **A-V9 完全体**：`InterfaceModeContribution` 增 `sceneSurface` 声明位 + `capabilities` 能力位；tactical-blue 经声明挂载装饰场景与 Overview 指挥台；App/AgentSheetView/OverviewSheetView 的模式 id 特判清零（共享 `useActiveInterfaceModeContribution` hook，内置表兜底） | 遗留 2 |
| `07832355` | **A-V12 持久化收敛**：`domains/appearance/settingsChromeStore`（zustand persist v1，四旧 key 一次性搬家+删除、恒跑 merge 规范化）；showPet 并入 layoutRailsStore（键名不变 per ADR-0009，envelope v3→v4 migrate 从旧 key 搬家）；migrate clamp 复用 `clampLeftRailWidth`（NaN 防护顺带修复）；`settingsChromeState.ts`/`showPetPersistence.ts` 删除；`PERSISTENCE_KEY_OWNERS` 台账同步 | 遗留 3 |
| `0be8dc7e` | **B-8a identityStore 拆五模块**：identityTypes（形状+显示名纯函数）/identityStoreShape（state 接口+accessor+mutation 序号守卫+owner hints）/identityProfileActions/identitySessionActions（逐字随迁）/identityPluginDataPort；主文件 801→109 行，消费面 import 面零改动 | 遗留 4 |
| `fc5eeb6f` | **B-8b normalizerSupport 拆派发表**：`contentBlockNormalizers.ts`（`CONTENT_BLOCK_HANDLERS` wire type → 族处理函数；13 族 + 帮助函数随迁）；`normalizeContentBlock` 313 行 switch 消解；normalizerSupport 1132→190 行（公共件+re-export） | 遗留 4 |
| `dd66dbad` | **B-8c pylonCliPorts 独立**：13 个 ControlPort + 工具 DTO + interaction wire 归一化拆 `pylonCliPorts.ts`；pylonCliService 832→555 行（`export *` 保面） | 遗留 4 |
| `419fc3e7`+`de69e9e5` | **B-2a 工厂契约倒置**：`workbenchHostPort.ts`（463 行）与渲染器工厂契约族（WorkbenchRendererFactory/PreparedWorkbenchRenderer/WorkbenchMountInput/WorkbenchOptionEntry 等）上移 plugin-runtime（`workbenchRendererFactory.ts`）；视图侧 workbenchContracts re-export 保面；**layer 门禁豁免 7→6** | 遗留 5 |
| `2afd133c` | **B-2b 编排值边 port 化**：`workspaceControllerPort` + `app/bootstrap/workspaceControllerWiring` 装配（identityCrossDomainPort 同款纪律：未注册即抛）；plugin-runtime 断视图值边；**layer 门禁豁免 6→5（B-2 清偿完毕）** | 遗留 5 |
| `2959275f` | **A-V2 client 注入收口**：`app/appClients.ts` 统一入口——无状态 client（chat/runtime/browser/docs/pet/browserAgentPanel/interactionResponse）进程单例，**有状态 client（agent/gateway 的 CAS revision 凭证、session 的 cold-mount turn 缓存）工厂成员**（按消费方会话新建，语义与收口前一致——评审发现全量单例会跨会话重放旧 revision，已修正）；视图层 20+ 文件自造 `createXxxClient` 与裸 invoke（user_session_delete(_finalize)/startup_diagnostics/migrate_appdata_to_portable/pet 通道）清零；sessionClient 增 deleteUserSessionLocal/finalizeUserSessionDelete、runtimeClient 增 migrateAppdataToPortable、新 petClient；**runtime 白名单 30→25** | 评论区补充项 |
| `cf08c2d0` | **A-V3 Settings 拆分**：AgentSettingsSection（概况卡+切换+发现+高级）/GlobalPresetSection（全局预设事务自持）/ZonePresetSection（sidebar/chat/cc/right 四段同构收敛）三 section 组件 + settingsAgentActions hook（switch/reconnect/reload 事务薄壳）+ useSettingsSearchNavigation（速搜定位）+ settingsSectionShared（Group/ZonePresetRow/错误口径）；773→327 行 | 遗留 1 |
| `96530bd9` | **A-V4 AgentRuntimePanel 拆分**：useAgentDetection（探测流收拢）/useAgentCandidateProvisioning（候选验证/导入/激活）/useAgentPanelFeedback（feedback+toast+冲突横幅统一原语）三 hook + AgentRuntimeCard/AgentCandidateList/AgentCreateForm 三子组件 + InvocationPreview/pickAgentExecutable/agentRuntimePanelDrafts 共享件；989→442 行，编辑流状态机（B1 draftMachine）保留在面板 | 遗留 1 |
| `fc9530bb` | **B-12 全局可变状态约定**：dev-standards 增「前端全局可变状态」节（三类合法形态：显式 lifecycle/create-get 分离/zustand store；配套持久化单落点、client 组装层取用、开关参数化）；双 projection 钩子 `*ForTests` 退役为生产语义 `uninstall*`（registry 类存量保持，按约定不强制回改） | 遗留 6 |

## 门禁证据（HEAD 实测）

- `bun run test`：657 文件 / 5,099 用例通过（1 skipped / 1 todo；含本批新增 settingsChromeStore 迁移 4 用例、layoutRailsStore.showPet 4 用例、interfaceModeRegistry sceneSurface 2 用例、interfaceModeScenes 4 用例）
- `bun run lint`：0 error / 1 warning（GatewaySheetView exhaustive-deps，R1/R2 已记录的存量，行号 193→191）
- `bunx tsc -b`：0 错
- `bunx vite build`：exit 0（.solid 盲区经构建兜底）
- `bun scripts/check-layer-boundaries.mts`：846 生产文件四层零越界，**豁免 5 条**（B-2 两条已删）
- `bun scripts/check-runtime-boundaries.mts`：通过，**白名单 25 条**（视图层 15 条已删）
- `bun run check:clippy`：各 crate `added: []`（零 Rust 改动；首跑红系本仓 dist 被清后 tauri generate_context 找不到 frontendDist，重建后绿）
- `bun run check:maintenance`：exit 0，`unmapped: []`（新文件全部落位）

## 关键取舍

1. **A-V2 有状态 client 不做全量单例**：agentClient/gatewayClient 的 revision 凭证、sessionClient 的 cold-mount turn 快照是**消费方会话状态**——进程级共享会让 CAS 冲突后的旧 revision 永远重放（AgentRuntimePanel 32 用例的真实回归揭示）。终态：无状态单例 + 有状态工厂成员。
2. **A-V12 收敛边界**：settingsChrome + showPet（issue 点名件）迁 zustand persist；sidebarModulePrefs/retentionPolicy 为契约/策略钉住的存量手写件，仅在注释与 dev-standards 标注「新代码不得再新增本形状」，不强行改键（ADR-0009 面）。
3. **B-8 拆分保 API 面零改动**：三处全部经 re-export 门面（identityStore/types、normalizerSupport、pylonCliService `export *`），消费方与测试 import 路径不动。
4. **B-2 倒置方向**：契约（host port + 工厂族）上移 plugin-runtime，实现留视图侧 re-export——与「插件套件消费的 seam 归扩展面」同构，非简单挪文件。
5. **A-V9 sceneSurface 只声明 surfaceId**：宿主场景注册表（`sheets/interfaceModeScenes.tsx`）持有组件真身，plugin-runtime 不沾 React；插件模式声明已登记 id 即获得等价装饰层。

## 验证限制

- 未做实机 webview2 验收：改动为结构与装配层，DOM 契约（class/aria/文案）逐字保留，657 文件级测试含全部组件视觉/交互用例；A-V2 的挂载接线变化经 vite build + mountSolidWorkbench 全量 solid 测试兜底。
- `check:frontend:static` 全链未逐环复跑（lint/build/wasm 已单独绿；csp/ipc/docs/deps 环节未被触碰，最终 PR 前由 CI 兜底）。

## 审查轮

独立子 agent 只读复审（对照 R1/R2 口径）：**总裁决「可 PR」**。8 项逐项核销全部「已修」（含派发表键集合与旧 switch case 值 set-identical 的机械比对、identityStore 三处动作逐字 diff、A-V2 各调用点生命周期逐一对照）；门禁七项独立复测与记录声称一致。

处置其发现（提交见 `git log`）：

1. **CONCERN-1（已修）**：W9 拆分时 chat 分区被过度同构加上 `<h3>`（旧 case 'chat' 无标题）——删除 label 传参恢复原 DOM。
2. **CONCERN-2（披露）**：AgentCreateForm 草稿随「收起新建」卸载重置，与旧实现「收起保留草稿」不等价（创建成功路径等价、失败保留等价）；注释已如实化，PR 描述披露。
3. **NOTE-3（已清 1 条）**：runtime 白名单中 `Settings.tsx` 死条目删除（其 pylon:agent-switched 派发已随 W9 迁 settingsAgentActions）；审查者建议的另 4 条经复核**保留**——CwdSettingsPanel/OverviewSheetView/activateAgentSheet/useSidebarContributionProps 仍在构造 `pylon:*` CustomEvent，条目未死。
4. **NOTE-4（已修）**：AgentConfigEditor 的 `createAgentClient` 收窄为 `import type`。
5. NOTE-5/6 复核确认非变更（settingsAgentActions 的 per-call client 不触 revision 缓存；候选草稿内联逐字段一致）。

修正记录本身两处：AgentRuntimePanel 实测 443 行（非 442，末行换行口径）；「视图层 15 条已删」补注（白名单清理以条目是否真死为准，5 条建议中 4 条仍活）。

