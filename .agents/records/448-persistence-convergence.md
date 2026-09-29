# Dev Record — 448 持久化真源收敛实施（#321 决议）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：#448（实施 #321 决议——用户 2026-09-28 拍板「收敛到后端权威」）
- 分支：`kumo/448-persistence-convergence`（基于 github/main `8572cb02`）
- 提交范围：`281373fa..`（PR1 `fc6abcb6` / PR3 `0deb7c4f` / PR2 `46254d3b` / PR4 `0e42b215` / PR2 收尾 `5952f01a` / PR5 `0cdd134c` + 记录）
- 日期：2026-09-30

## 目标与范围

issue #448 规划的五个逻辑单元（单分支逐单元提交，各自独立可 revert）：

1. **PR1（后端）**：`UserDataKey` 加 `input-prediction` + 结构防守校验器 + 单测。
2. **PR2（前端）**：`inputPredictionSettingsRepository`（照 retentionPolicyRepository 形状）+ 旧 localStorage key 一次性迁移（写穿 + 删旧 / 失败保留幂等重试）+ InputBar 等同步直读改缓存消费。
3. **PR3（后端）**：`approval-mode` key + `set_approval_mode` 写穿（失败降级内存生效 + warn）+ 启动阶段 10b 从 user_data 回填内存态。
4. **PR4（前端）**：App.tsx 启动顺序反转（后端权威优先，localStorage 降级为首次种子），移除「本地有值即推送」漂移路径。
5. **PR5**：customPresets/zonePresetEntries 拆独立 `useCustomPresetStore`（persist `pylon-custom-presets`）+ `custom-presets` user_data key 写穿 + 旧 `pylon-theme` 内嵌字段一次性搬家。

**不做**：apiKey 加密（与现状同级明文，另议）；整包主题迁移；identityStore API（identity 写穿协议整体 + `user_session_patch` 行级修订 + autoName 写放大 = 后续阶段另批）；browser 预览 localStorage 直写分支（永续保留）；`agentWorkbenchSession.ts`（#442 错峰）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/pylon-session/src/user_data.rs` | UserDataKey 三新变体（as_str/parse/save 分发）+ validate_input_prediction / validate_approval_mode / validate_custom_presets + UserDataService::load_sync（setup 栈内同步读）+ 单测 12 条 | 修改 |
| `src-tauri/src/permission.rs` | set_approval_mode 写穿（service 未就绪/落盘失败降级 warn）；restore_persisted_approval_mode 启动回填 + 单测 3 条 | 修改 |
| `src-tauri/src/lib.rs` | 阶段 10b setup_restore_approval_mode 接线（一行 + 注释） | 修改 |
| `src-tauri/src/test_utils.rs` | TestStateBuilder 加 with_user_data_service 注入口 | 修改 |
| `src/infrastructure/persistence/inputPredictionSettingsRepository.ts` | 新：hydrate（后端有值/迁移/降级三分支）+ persist（缓存先行 + 盲写）；IPC 走 #317 共享 tauriInvokeTransport | 新增 |
| `src/domains/inputPrediction/inputPredictionSettingsCache.ts` | 新：同步读缓存（未 hydrate 回落 localStorage，与旧行为逐字等价） | 新增 |
| `src/infrastructure/prediction/predictionStandalone.ts` / `src/renderers/solid-workbench/input/InputBar.solid.tsx` / `mountSolidWorkbench.solid.tsx` | 同步直读改缓存读；router 显式注入 settings（避免 cache↔settings 循环 import） | 修改 |
| `src/components/settings/InputPredictionSettingsPanel.tsx` | 读写走 repository | 修改 |
| `src/domains/permission/approvalModeRestore.ts` | 新：注入式启动恢复事务（决策可脱离 App.tsx 巨组件做确定性行为测试） | 新增 |
| `src/App.tsx` | approval 启动 useEffect 反转接线；hydrateDomains 挂两处 hydrate | 修改 |
| `src/infrastructure/tauri/runtimeClient.ts` | loadApprovalModePersisted（user_data_load 探询） | 修改 |
| `src/domains/theme/customPresetStore.ts` | 新：独立 persist store + 搬家 storage adapter + 跨 store 事务（合成视图注入 presetActions） | 新增 |
| `src/domains/theme/legacyPresetStash.ts` | 新：搬家数据源暂存（读序无关双保险） | 新增 |
| `src/infrastructure/persistence/customPresetRepository.ts` | 新：后端对账 hydrate + 写穿桥（syncing guard 防回环）；IPC 走共享 transport | 新增 |
| `src/domains/theme/themeStore.ts` | 拆两 state 字段 + 5 预设动作 + partialize 两行；migrate 钩子 stash | 修改 |
| `src/domains/theme/migration.ts` | customPresets 归一职责移交（alias 引用改写保留）；import 收窄 | 修改 |
| `src/domains/theme/presetReducer.ts` | ThemePresetState.customPresets 改可选切片 | 修改 |
| `src/domains/theme/presetActions.ts` | PresetStoreApi 改合成视图（get 合并两 store，set 按字段路由） | 修改 |
| `src/components/Settings.tsx` / `settings/TemplateLibrary.tsx` | 预设 selector/actions 改源 useCustomPresetStore | 修改 |
| `src/test/resetStores.ts` | 重置清单加新 store | 修改 |
| 说明书《Pylon-项目架构参考》《Pylon-CLI-命令表》 | user_data 三 key / 权威收敛段 / approval set 持久化 | 修改 |

## 方案要点

1. **PR1/PR3/PR5 后端**：`user_data_load/save` IPC 命令面零改动（key 为 String 参数，加 enum 变体即放行）。校验器只做结构防守（version/枚举/字段类型/条目上限），字段级归一是前端权威。
2. **PR3 时序**：setup 回调跑在 `rt.block_on` 的 runtime 栈内，**不能嵌套 block_on**——回填走新增的 `UserDataService::load_sync`（启动路径无并发写者，同步读单行安全），挂在阶段 10（persistence services 就绪）之后、任何命令可达之前。
3. **PR4 种子判定**：`get_approval_mode` 返回值无法区分「持久化的 default」与「从未存过」——前端改经 `user_data_load('approval-mode')` 判定持久层，null 且本地有值才做一次性种子（种子成功后后端有值，下次走权威分支）。
4. **PR5 搬家竞态（本批最重要的发现）**：zustand persist 的 **migrate 写回路径经 partialize 白名单**——themeStore 的 migrate 把结果写回 pylon-theme 时，customPresets/zonePresetEntries 字段无论在 migrate 输出里怎么透传都会被洗掉。若 customPresetStore 的搬家读取发生在写回之后，用户预设静默丢失。三层错误方案被实测否决（模块级同步快照——测试 runner 预热模块使快照空跑；migrate 输出透传——被写回路径洗掉；getItem 现场读——读序无保证）。**最终方案**：themeStore 的 migrate 钩子在被洗掉**之前**把 persisted 里的预设字段原样暂存独立模块（`legacyPresetStash`），搬家 getItem 优先读暂存、暂存空再现场读（读取若先于写回，现场还是原值）——读序无关双保险。测试 `新键无数据 → 从旧 pylon-theme 内嵌字段提取` 钉住该场景。
5. **PR5 跨 store 事务**：`removeCustomPreset`/`removeZonePresetEntry` 的 reducer 同时产出预设列表删除与主题侧 `appliedPreset`/`custom` 回写——经 `presetCombinedApi`（get = 两 store 合并视图、set 按字段路由）注入 presetActions/presetReducer 既有纯函数，事务骨架（快照/回滚/串行队列）零改动。
6. **门禁零豁免**：两个新 repository 的 IPC 走 #317 收口的共享 `tauriInvokeTransport`（运行时边界门禁的 DIRECT_INVOKE_ALLOWLIST 零新增），满足 issue 验收「未新增白名单豁免」。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| PR1/PR3 各自单测绿 | ✅ pylon-session user_data 35 passed（含新增 12）；pylon permission 19 passed（含新增 3，写穿/降级/回填） |
| approval mode：CLI set 后重启不回滚（漂移路径消除） | ✅ 后端写穿单测 + 前端 `restoreApprovalModeFromBackendAuthority` 行为测试 6 条（「后端在场 → 应用权威值，不种子不推送」钉住推送分支不存在） |
| inputPrediction：Tauri 落 SQLite（删 localStorage 重开不丢）；旧 key 一次性迁移；browser 行为不变 | ✅ repository 测试 7 条（迁移/删旧/幂等重试/降级）；browser 分支 IS_TAURI=false 永续保留 |
| customPresets：Tauri 落 SQLite；旧 pylon-theme 搬家；browser 行为不变 | ✅ store 测试 7 条（搬家三态/写盘隔离/跨 store 路由）+ repository 测试 5 条（对账/写穿桥/吞错） |
| `bun run check:all` 绿（含 check:clippy） | ✅ exit 0（fmt 修正 + 1 条 redundant_clone 修复后） |
| 未新增白名单豁免 | ✅ DIRECT_INVOKE_ALLOWLIST 零新增（走共享 transport） |

## 测试处置

- **新增**：user_data 校验器三组（Rust）；permission 写穿/降级/回填 3 条（Rust）；inputPredictionSettingsRepository 7 条；customPresetStore 7 条（含搬家竞态回归）；customPresetRepository 5 条；approvalModeRestore 6 条。
- **修改**（拆分随迁，逐个点名）：`Settings.customPreset.test.tsx`（selector/mock 改新 store）；`TemplateLibrary.globalPresets.test.tsx`（同）；`customPresetApply.test.ts`（动作调用改新 store；「持久化往返」用例从 themeDomainMigrate 改为经新 store merge 归一）；`customPresetOverwrite.test.ts`（动作改新 store）；`migration.test.ts`（A1 命名空间用例改为钉「migrate 函数输出无损透传 + 归一职责移交」契约；空状态用例断言字段不注入）；`presetReducer.test.ts`（类型索引改 CustomPreset 直引）；`zonePresetPool.test.ts`（预设动作/写盘断言改新键）；`factoryZonePresets.test.ts`（同）；`resetStores.ts`（重置清单）。
- **删除**：无。

## 证据

- commit：`fc6abcb6`（PR1）/ `0deb7c4f`（PR3）/ `46254d3b`（PR2）/ `0e42b215`（PR4）/ `5952f01a`（PR2 收尾）/ `0cdd134c`（PR5）。
- 测试：`cargo test -p pylon-session --lib user_data` → 35 passed / 0 failed；`cargo test -p pylon --lib permission::` → 19 passed / 0 failed；`bun run test` → **659 文件 / 5121 用例全绿**（基线 660 文件 / 5104：拆分后 customPresetApply 等文件用例并入新文件，净增约 20 用例）；`bun run check:all` → **exit 0**（含 lint / check:rust / check:clippy（各 crate `added: []`、基线未动）/ check:solid（运行时边界 + 分层门禁零违例））；`cargo fmt --all --check` → 干净。
- 手工验证：未做实机运行验收（本批改动均为持久化链路且已有行为测试钉住各分支；真机 SQLite 落盘的端到端复验可按 webview2-acceptance skill 配方后补，属验收限制见下）。

## 与 spec 的偏差

- spec 原计划「customPresetStore 搬家经 storage adapter 交叉读取」——实测撞上 migrate 写回经 partialize 洗字段的竞态，三层方案被否决后改为 **legacyPresetStash 暂存双保险**（见方案要点 4），并新增 `legacyPresetStash.ts`。spec 的其余方案按计划落地。
- spec「PR1 只加 input-prediction」：后端 enum 变体按逻辑单元分属三笔提交（PR1/PR3/PR5 各自含自己 key 的完整校验器+测试），与 issue 的五 PR 划分一致。

## 未解问题

1. **实机验收未做**：Tauri 下「删 localStorage 重开不丢」「CLI set 重启不回滚」的端到端真机复验（webview2-acceptance 配方）留待合并前按需补——行为已由三层单测分别钉住（后端落盘/回填、前端恢复事务、迁移分支），但真机组合时序未走查。
2. **#321 验收判据一的「双模式持久化契约 ADR」未见 `.agents/decisions/` 落地**（最新 0034）——决议原文在 #321 评论区（2026-09-28 用户拍板）。是否补录 ADR 归仓库主裁决。
3. identity 后续阶段（`pylon:identity-changed` 广播 / `user_session_patch` 行级修订 / 删除编排单命令化 / 前端镜像降级纯缓存）按 issue 原文「另批评估」，本批未动。

## 并行交集

本次碰过的共享文件，供其他贡献者避让：`src-tauri/pylon-session/src/user_data.rs`、`src-tauri/src/{permission,lib,test_utils}.rs`（lib.rs 仅阶段表一段）、`src/App.tsx`（approval effect + hydrateDomains）、`src/domains/theme/{themeStore,migration,presetReducer,presetActions}.ts`、`src/components/Settings.tsx`、`src/infrastructure/tauri/runtimeClient.ts`、`src/test/resetStores.ts`。**未碰**：`src-tauri/src/session/mod.rs`（#379 域）、identityStore/identityBackendSync、`agentWorkbenchSession.ts`（#442）、msg_repo。
