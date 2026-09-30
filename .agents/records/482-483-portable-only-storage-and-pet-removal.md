# Dev Record — #482 便携唯一存储真源 + #483 宠物全链删除

> 入库保留。规格文档不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：#482（enhancement）、#483（bug），单 PR 批次
- 分支：`kumo/482-483-portable-pet`（独立 worktree `G:/Project/prism-team-workdir/pylon-482-483`，基于 github/main `df6cd864`——共享树当时被 #486-488 批次占用，按 §2.5 并行冲突条款隔离）
- 提交范围：`df6cd864..ad8d4c15`（L.md 声明 `9d757d7d` + #482 `12a4f706` + #483 `ad8d4c15`）
- 日期：2026-10-01

## 目标与范围

- **#482**：维护者裁决「便携版作为唯一存储真源」。删除 AppData→portable 迁移链（含 copy/rename 双清单不对称的数据丢失级缺陷——修法不采纳，缺陷随链消解）；AppData 双模式按「彻底删除」档退役。
- **#483**：审计 P1-①，维护者裁决「删除全链」。宠物组件/样式/开关/占位落点 + `showPet` 从主题契约退役。
- **不做什么**：`src-tauri/pet-core/`、`src-tauri/src/pet/` 命令层、`petClient`/`petContracts` 及其测试全部保留（「将来重做宠物 UI 时再启用」面）；`pack_release.py` 打包行为不动（`portable.flag`/`data/` 照旧产出，仅文档措辞同步）；不做任何 AppData→portable 数据搬迁（无外部用户，旧 AppData 数据原地弃置）。

## 改动清单

### #482（`12a4f706`，13 文件 +95/−800）

| 文件 | 范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/paths.rs` | 迁移链全量（staging/copy-rename 双清单/迁移命令/检测函数）、`StorageMode`、`DataDirs` 三诊断字段、`portable_requested()` 探测、`APP_IDENTIFIER`/`platform_data_root`/`app_data_root`；`resolve_data_dirs_for` 改为便携唯一（不可写即 Err），`resolve_data_dirs` 去 Tauri 依赖；日志候选单化 | 修改（769→250 行） |
| `src-tauri/src/lib.rs` | `setup_migrate_appdata`/`setup_install_storage_diagnostics` 两阶段删除、阶段注释重排（18→16）、命令注册行摘除 | 修改 |
| `src-tauri/src/startup.rs` | `StorageDiagnostics` 结构体 + `StartupDiagnostics.storage` 字段 + 两个序列化测试；新增退役回归钉 | 修改 |
| `src-tauri/src/{mcp/mcp_persist_tests,plugin_process/tests,workspaces/mod}.rs` | DataDirs 字面量构造随迁 | 修改 |
| `src/infrastructure/tauri/{runtimeClient,runtimeLogContracts}.ts` + `tauriClients.test.ts` | `migrateAppdataToPortable`、`StorageDiagnostics`/normalize/`storage` 字段摘除 | 修改 |
| `src/sheets/OverviewSheetView.tsx` + `builtin.pylon-workspace/.../OverviewSheetView.css` | 迁移横幅/状态/effect 摘除 + 孤儿 `.overview-migration` 规则 | 修改 |
| `docs/说明书/{Pylon-发行包清单,Pylon-模块维护地图}.md` | portable.flag 措辞、Native host 行同步 | 修改 |

### #483（`ad8d4c15`，43 文件 +58/−1150）

| 文件 | 范围 | 性质 |
| --- | --- | --- |
| `src/components/{PetCompanion.tsx,petVisualPose.ts}`、`__tests__/PetCompanion.{test.tsx,css.test.ts}`、`builtin.pylon-renderers/.../PetCompanion.css`、`layoutRailsStore.showPet.test.ts` | 全文件 | 删除 |
| `Settings.tsx`/`Sidebar.tsx`/`settingsDomains.ts`/`settingsContributionCatalog.ts` | 「宠物」分区/`profile-pet` 按钮/`'pet'` section/showPet 记录与 skip 条件 | 修改 |
| `builtinWorkspaceCommands.ts` | `layout.pet.set` 命令删除、`layout.inspect` 摘 showPet | 修改 |
| `WorkbenchContent.solid.tsx` + `WorkbenchChrome.css` + `styleAssets.ts` + `firstPartyStyleOwnership.ts` | 占位 Show 块/隐藏规则/资产登记行摘除 | 修改 |
| `themeTypes`/`themeFieldDefs`/`themeStore`/`zones/factory/{gui,terminal}-global`/`appearance.ts`/`workbenchSkinContract`/`zustandWorkbenchAppearanceStore`/`layoutRailsStore` | showPet 字段群退役（appearance store 的 rails 订阅仅因 showPet 存在，一并简化） | 修改 |
| `AgentSheetView.tsx`/`legacyKeyMigration.ts`/`env.ts`/`petClient.ts`/`Sidebar.css` | 透传字段/遗留 key 登记/注释/样式（`:is(...)` 选择器收窄） | 修改 |
| 测试 9 文件 + `demoData.ts` + `scripts/{check-theme-field-consistency,sheetPersistenceV2.compat.test}.mts` | 断言随迁；`effectivePresetTheme` 键数基线第七次按实测重算 | 修改 |

## 方案要点

1. **#482「便携唯一」的语义**：`<exe_dir>/data/` 是唯一数据/配置根，缺失即探针就地创建；不可写（只读介质/Program Files/被普通文件占据）→ 脱敏原因 Err，启动管道按〔致命〕中止。原「未请求 portable → AppData」的第三态随双模式删除而不存在——`portable.flag` 不再参与判定（打包器照旧产出，仅身份标记）。
2. **日志根单化**：`log_dir_candidates` 只剩 `data/logs`；`APP_IDENTIFIER` 等纯 AppData 解析面随回退场景消解，配套的 tauri.conf.json 钉子测试一并退役（维护地图已同步）。
3. **StorageDiagnostics 全退**：四个字段唯一生产消费者是 Overview 迁移横幅；横幅删除后无消费者，DTO 字段/normalize/前端类型成串退役，双端各留一枚「不得复现」回归钉。
4. **#483 showPet 退役靠类型系统兜底**：从 `THEME_FIELD_DEFS`（`ThemeFieldKey` 派生源）删起，owner override、`WORKBENCH_THEME_KEYS`、`createDirtyTheme`、投影、工厂字面量的残留全部被 tsc 强制暴露、逐点清偿。layoutRailsStore zustand persist envelope **维持 version 4**（v3 migrate 仍服务布局字段；旧 showPet 值被 migrate 静默丢弃；旧 `pylon-workspace-show-pet` key 成为无害孤儿不再登记）。
5. **键数基线第七次重算按实测**：玻璃/agent-* 预设切面本就不含 showPet（probe 实测 64/37 不变），仅 6 套完整快照型 177→176——避免了一刀切减 1 的错账。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `cargo test --workspace --lib` | 9 目标 **1662 passed / 0 failed** |
| `bun run check:clippy` | exit 0，`added: []`（基线外零新增） |
| `cargo fmt --all -- --check` | exit 0 |
| `bun run test` | **661 文件 / 5179 passed / 0 failed**（1 skipped 计划内） |
| `bun run check:solid` | 11 项门禁 exit 0（含主题三方一致性：176 字段） |
| `bun run check:frontend:static` | exit 0（含 build/bundle/产物反证/文档链接） |
| `bun run lint` | 0 error（1 warning 为 main 存量，GatewaySheetView，未触碰） |
| 生产代码零残留 | `grep -rn "migrate_appdata\|StorageMode\|migration_available\|fallback_reason\|portable_requested" src-tauri/` 零命中；`showPet\|PetCompanion\|petVisualPose` 仅剩防复活负钉与退役注释 |
| `src-tauri/**` 零改动（#483） | `git show --stat ad8d4c15` 无 src-tauri 路径 |

## 测试处置

- **删除**：`PetCompanion.test.tsx`、`PetCompanion.css.test.ts`、`layoutRailsStore.showPet.test.ts`、paths.rs 迁移三测试 + `portable_requested_by_data_dir_or_flag` + `app_identifier_matches_the_tauri_bundle_config`、startup.rs 两个 storage 诊断测试、Sidebar.agentSessions 的 showPet describe 块、settingsDomainNav 的「宠物分区」断言改写。
- **新增**：`resolve_uses_exe_dir_data_as_only_root`、`resolve_fails_fatal_when_data_root_unwritable`（#482 致命路径回归钉）、`startup_diagnostics_has_no_storage_section`、workbenchChromeCss/mountSolidWorkbench/settingsContributionCatalog 三处「pet 不得复现」负钉。
- **契约变更随迁**：`effectivePresetTheme` 键数基线（177→176 ×6）、`firstPartyStyleOwnership` renderers 计数（7→6）、`builtinCliCommandCoverage` 词表（-layout.pet.set）、settingsDomains 归属表、`tauriClients` normalize 形状断言。

## 证据

- commit：`12a4f706`（#482）、`ad8d4c15`（#483）、`9d757d7d`（L.md 声明）
- 测试：上表门禁命令全部本地实跑，exit 0 附计数
- 手工验证：未做实机 PE 验收——#482 的「便携根不可写」真实只读介质场景 CI 无法模拟，已用「data 被普通文件占据」等价形态钉入单测；实机验收由维护者按需触发（webview2-acceptance skill）

## 与 spec 的偏差

1. `AgentSheetView.tsx` 的 showPet 透传、`builtinWorkspaceCommands` 的 `layout.pet.set` 命令、`legacyKeyMigration` 的遗留 key 登记、`Sidebar.css` 的 `.profile-pet` 样式、`env.ts`/`petClient.ts` 注释——spec 勘探时未列入，施工期引用扫描补获，按「相关零散引用以引用扫描为准」纳入。
2. `effectivePresetTheme` 键数基线与 `firstPartyStyleOwnership` 计数 pin 的随迁（spec「测试处置」未点名）——类型/守卫强制暴露的连带面。
3. 其余与 spec 一致。

## 未解问题

- 无阻塞项。备注：`petClient`/`petContracts`/Rust `src/pet` 命令层在宠物 UI 重建前保持零生产消费者（petContracts.test 仍覆盖），将来重做宠物 UI 时按 ADR-0035「新增 UI 一律 Solid」口径启用。

## 并行交集

- 施工全程在独立 worktree，未触碰共享树。
- `src/plugins/product/firstPartyStyleOwnership.ts` 与在途 #484（卫生批）声明域重叠：本批只摘 PetCompanion.css 一行；#484 的 PrismSheet 行按 hunk 分账，rebase 时保留双方语义。
- `builtin.pylon-renderers/styleAssets.ts`（本批）与 #484 的 `builtin.pylon-workspace/styleAssets.ts` 是不同文件，无冲突。
- 会话初期在共享树误落的一枚 L.md 声明提交（`88351308`，落在 #486-488 分支）内容与本 worktree `9d757d7d` 相同，两边合并时 L.md 同行追加可自动归并，合入后随条目撤除即可。
