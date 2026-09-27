# Dev Record — #351 前端 src 根目录散落文件归类（状态层按域下沉 + 断 identity 跨域横向 import）

## 元信息

- issue：#351（refactor，assignee AlchemistCxC；#245 后端同类件的前端对应）
- 分支：`kumo/prometheus`
- 提交范围：`1cacaddf..59b17bab`（7 个提交：L.md 声明 ×1 + 物理搬移 ×4 + 解耦 ×1 + 门禁/文档随迁 ×1）
- 日期：2026-09-26

## 目标与范围

把 `src/` 根目录 23 个散落文件按真实调用者下沉到既有模块桶（维护地图 audit「按真实调用者逐步下沉」方向的执行），并断裂 `identityStore → workspaceStore/runtimeStore` 的域间横向 import。**不做什么**：主题/预设集群（`store.ts` 等 6 文件 + `presets//zones/`，#266 在途风暴区）不动；入口四件（main.tsx/App.tsx/index.css/\*.d.ts）不动；不改任何 store 状态形状、persist key、事件时序。

## 改动清单

| 落点 | 文件（basename 全保持，utils.ts 除外） | 性质 |
| --- | --- | --- |
| `src/domains/identity/` | identityStore、identityPersistence、sessionPersistence、profilePersistence | 重命名（自 src 根） |
| `src/domains/agent/` | agentContext | 重命名 |
| `src/domains/workspace/` | workspaceStore、workspaceEntities | 重命名 |
| `src/domains/runtime/` | runtimeStore | 重命名 |
| `src/domains/cc/` | ccHeightState、ccLayoutState | 重命名 |
| `src/infrastructure/persistence/` | identityBackendSync、userDataRepository、retentionPolicyRepository、workspaceEntityStore、windowSizePersistence | 重命名（IPC/localStorage 件不进 domains，保持 domains 零 `@tauri-apps` 现状） |
| `src/infrastructure/skin/` | backgroundImage | 重命名（convertFileSrc 资产适配） |
| `src/components/right-panel/` | rightRailStore(+test) | 重命名（与 RightRailHost 同居） |
| `src/components/settings/` | settingsDomains(+test) | 重命名 |
| `src/app/` | runtimeError、errorCenter、errorCodeExplanations(+tests) | 重命名（应用级错误与恢复） |
| `src/application/` | configExportImport(+tests) | 重命名 |
| `src/utils/` | utils.ts → **relativeTime.ts**（按内容定名，唯一改名） | 重命名 |
| 兄弟测试 14 件 | `src/__tests__/` → 各家族 `__tests__/` | 重命名 |
| `src/app/ports/identityCrossDomainPort.ts` | 端口契约：sheetAgentStates 读 + patch/prune/clearSessionSource 写，未注册显性抛错 | 新增 |
| `src/app/bootstrap/identityCrossDomainWiring.ts` | 装配：verbatim 委托到 workspace/runtime 域 store | 新增 |
| `src/domains/identity/identityStore.ts` | 12 个跨域调用点改端口调用；删除对 workspace/runtime 的 import | 修改 |
| `src/App.tsx`、`src/test/resetStores.ts` | side-effect import 装配（生产/测试各一处） | 修改 |
| `scripts/check-runtime-boundaries.mts` | DIRECT_INVOKE_ALLOWLIST 根条目 ×3 路径随迁（直发面不变，无新增豁免） | 修改 |
| `scripts/audit-maintenance.test.mts` | 根桶断言 `src/identityStore.ts`→`src/store.ts`（#266 域代表），并锁定 identityStore 归属 domain 桶 | 修改 |
| `docs/说明书/Pylon-项目架构参考.md`、`Pylon-模块维护地图.md` | identity 行、前端根文件桶、根 store 债务行同步 | 修改 |

import 重写共 391 处 specifier（三批 codemod：批1 193 + 批2 187 + 批3 152，含批间重叠修正），覆盖 `import/from/export from/dynamic import/vi.mock` 五类语法。

## 方案要点

- **IPC 与纯域分家**：domains 现状零 `@tauri-apps` import，故 identityStore 落 `domains/identity/` 而其 SQLite 写穿件（identityBackendSync/userDataRepository）落 `infrastructure/persistence/`——家族在目录层断开、在语义层保持（与 #228 批次D 的拆分方向一致）。
- **横向 import 断裂用同步端口**：identity 的组合 action（setActiveProfile/removeProfile/removeSession/setAgents/setActiveAgent/hydrate 读 hint）在**原调用点**经端口发同步调用，处理器 verbatim 委托，读写时序逐点不变。端口未注册即抛错（不静默降级），装配遗漏显性失败。生产在 App.tsx、测试在 resetStores 各一行 side-effect import 装配。
- **codemod 按 importer 目录重算相对路径**，显式/无扩展名两种风格都保持；vite manualChunks 只钉产品包与 vendor，chunk 归属不受影响。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 全量 `bun run test` 绿 | 5,002 passed / 652 files（1 skipped、1 todo，0 失败，90.6s） |
| `tsc -b`（主工程）+ `tsc -p tsconfig.solid.json` 绿 | 每批搬移后均验证，零错误 |
| `bun run lint` 绿 | 0 errors（1 条 pre-existing warning，GatewaySheetView exhaustive-deps，非本批文件） |
| `check:boundaries` 绿 | 33 条 legacy 白名单仅报告，无新增 invoke/store/CustomEvent 越界 |
| `check:maintenance` 绿 | unmapped = 0 |
| `check:docs` / `check:csp` / `check:canonical-types` / `check:retention-policy` / `check:ipc` / `check:first-party-styles` / `check:tailwind-tokens` 绿 | 全过 |
| `check:solid` 链 10 个边界脚本 | 全过（solid tsc 另行验证） |
| identityStore 无 workspaceStore/runtimeStore import | `grep` 零命中，仅经端口单向装配 |
| 无新增白名单豁免 | allowlist 净变化 = 3 条路径随迁 |

## 测试处置

- `identityStore.hydration.test.ts`：补 1 行装配 import（该文件不经 resetStores，需显式获得与生产一致的端口装配）；console-error 白名单路径随迁 `vitest.setup.ts`。**断言零改动。**
- `audit-maintenance.test.mts`：根桶断言样本随迁移更新（见上），新增 domain 桶正向断言。
- 其余全部测试仅 import 路径修正。

## 证据

- commit：`1cacaddf..59b17bab`（pathspec 提交；src-tauri 在途改动未触碰）
- 测试：全量 vitest「652 files / 5,002 tests passed, 0 failed」；交叉行为面（identity/workspace/runtime/bootstrap/tsWi/del05/p3Routing）107/107 绿
- 门禁输出：boundaries「运行时边界门禁通过：33 条遗留白名单仅报告」；maintenance「unmapped: []」；ipc「219 命令双向一致」

## 与 spec 的偏差

- 补搬 `windowSizePersistence.ts`（spec 盘点遗漏，localStorage 持久化件，归属 infrastructure/persistence）。
- 磁盘 100% 满事件：施工中 G: 盘写满，删除 `src-tauri/target/debug/incremental`（9.2GB 纯编译缓存，按需再生）释放空间；部分 .o 被在途 cargo 进程锁定未删净，不影响其构建正确性。

## 未解问题

- 主题/预设集群的下沉（store.ts 等 + presets//zones/）留待 #266 功能清账后另行立件。
- GLOBAL_STORE 白名单余量：plugins/renderers 10 个 global store import 消费点仍是存量债务（ADR-0023 梯队问题，另行裁决）。
