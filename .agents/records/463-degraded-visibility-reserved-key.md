# Dev Record — 463 决策口收口：degraded 外部可查 + approval-mode 绕锁面拒绝

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：#463（两项开放决策口，用户 2026-10-01 指令「完成 issue 463」＝按登记建议方向裁决实施）
- 分支：`kumo/prometheus`（共享树在途：[Codex] Cargo.toml、#515 前端 Solid 化 27 文件——与本域零交集，pathspec 提交避让）
- 基准提交：`b4bd47c7`
- spec：`.agents/spec/463-degraded-visibility-reserved-key.md`（一次性，不入库）

## 目标与范围

issue 期望行为第三条「degraded 状态外部可查」（审查项 3，wire 契约决策口）+ 审查轮新增登记「`user_data_save` 盲写 approval-mode 绕锁面」。两项此前均「待仓库主裁决」；本批按裁决实施：

1. **项 3**：set 返回持久化标志 / get 附健康位。
2. **绕锁面**：对该 key 拒绝（专用错误码强制走 set_approval_mode）——两建议方向（拒绝 vs 内部转发）取**拒绝**：内部转发会让通用 envelope 命令产生写内存副作用；拒绝最小面且不改变 `user_data_save` 语义。

**不做**：#463 未修 NIT（sameSlice 键序/字面量双写/trim 口径/lock poisoned）保持原样；`user_data_load` 不拒绝（读不产生分叉 + 前端 approvalModeRestore 种子探询依赖）；GUI set 链（App.tsx/runtimeClient）不消费返回值，不动；进程外 pylon-cli crate 零引用 approval（grep 确认），不动。

## 改动清单

| 文件 | 内容 |
| --- | --- |
| `src-tauri/pylon-session/src/user_data.rs` | `UserDataError::ReservedKey { key }` 变体 + code `user_data_reserved_key` + 单测（机器码钉住） |
| `src-tauri/src/session/mod.rs` | `user_data_save` IPC 对 approval-mode key 拒绝（parse 后、service 前）；`user_data_load` 保持允许 + 单测两枚（拒绝/仍可读） |
| `src-tauri/src/lib.rs` | AppState 增 `approval_mode_persisted: Arc<AtomicBool>`（构造默认 true）+ 写序锁注释更新 |
| `src-tauri/src/permission.rs` | `ApprovalModeSnapshot { mode, persisted }` wire 类型；`set_approval_mode` 返回快照（save Ok→true/Err→false/无 service→false）；`get_approval_mode` 返回快照；`restore_persisted_approval_mode` 四态置位（回填成功 true/无持久值 true/坏 envelope false/读失败 false/无 service false）；测试更新 + 新增 `restore_without_service_marks_persisted_false` |
| `src-tauri/src/dispatcher/{mod,crash_reconnect}.rs` | `AppStateHandles` 两处字面量构造补新字段（宏 shared 段要求全字段） |
| `src/cli/pylonCliPorts.ts` | `ApprovalModeSnapshot` 类型 + `ApprovalControlPort.get/set` 返回快照 |
| `src/cli/pylonCliDomainPorts.ts` | `createCliApprovalControlPort` invoke 透传快照 |
| `src/cli/pylonCliService.ts` | `approval get/set` 透传后端快照（不再回显入参——mode 由后端确认；persisted=false 不 throw，可见可查 ≠ 拒绝） |
| `src/demo/mockTauri.ts` | set 返回快照；补 `get_approval_mode` case（demo 既有 reject 缺口顺路闭合） |
| `src/cli/__tests__/pylonCliService.test.ts` | mock port 快照形状 + approval 两分支断言更新 |
| 说明书《Pylon-CLI-命令表》《Pylon-项目架构参考》 | approval get/set 输出形状（+persisted、reserved key 语义）；approval-mode 段「待裁决面」表述改为已落地 |

## 方案要点

1. **健康位语义**：`approval_mode_persisted` =「内存当前值是否已被 SQLite 持有（或从未偏离持久层）」。乐观默认 true（回填成功/无持久值都算健康——默认值与磁盘无偏离）；仅显式失败置 false。set 的返回快照在锁窗口后读健康位，各自 set 自证（自己 save 成功即 store(true)）。
2. **保存失败臂不可直接单测**：in_memory 基建无法注入 `service.save` 失败（与 #448 审查 C-3 同口径：不可达分支不硬造测试）——None-service 臂 + save-Ok 臂夹逼语义，注释如实登记。
3. **拦截点在 IPC 层**（parse 后、service 前）：`service.save` 不拦——`set_approval_mode` 自身经 service 写穿；Rust 侧 service.save 调用方仅本命令与 permission.rs（grep 盘点），IPC 拦截即封死唯一外部路径。
4. **wire 兼容性**：`set` 原返回 `null` → 现 `{mode, persisted}`（GUI seedToBackend 不消费返回值，零破坏）；`get` 原返回 `String` → 快照（唯一消费方 CLI 桥已同步；进程外 pylon-cli 零影响）。CLI 输出 `mode` 字段保留，旧消费者零破坏。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| set 落盘成功 persisted=true / 无 service persisted=false + get 一致 | ✅ `set_approval_mode_persists_to_user_data` / `set_approval_mode_degrades_to_memory_without_service` |
| restore 四态置位 | ✅ `restore_persisted_approval_mode_reads_back_written_value`（回填/无值→true）+ `restore_without_service_marks_persisted_false` |
| 并发 set 测试适配（快照断言） | ✅ `set_approval_mode_concurrent_writes_keep_disk_equal_to_memory` |
| `user_data_save('approval-mode')` 拒绝 + load 仍通 | ✅ `user_data_save_rejects_reserved_approval_mode_key`（含磁盘无行断言）/ `user_data_load_still_allows_approval_mode_key` |
| ReservedKey 机器码 | ✅ pylon-session `reserved_key_error_carries_stable_code` |
| CLI parity | ✅ `src/cli` vitest 2 文件 27 passed |
| `cargo test --workspace --lib` | ✅ 全 crate 0 failed（pylon 968 / pylon-session 36 / 其余 93+217+186+137+9 等） |
| `bun run check:clippy` | ✅ added: []（基线零新增） |
| `cargo fmt --all --check` | ✅ 干净 |
| `tsc -b` | ✅ 0 错 |
| `bun run test` 全量 | ⚠️ 5165 passed / **4 failed**——全部位于 #515（前端全量 Solid 化）正在施工的 store 域（`defaultPresets.test.ts` 3 + `sessionSettingsLifecycle.test.tsx` 1；被测生产文件 themeStore/customPresetStore/settingsChromeStore 等均在其 27 文件在途改动清单内），与本批改动文件域零交集（本批前端面仅 `src/cli/*` + `mockTauri.ts`）；单独复跑仍红，属共享树施工中间态，非本批引入。 |

## 测试处置

- 新增：ReservedKey 机器码 1 条；user_data_save 拒绝/load 允许 2 条；restore 无 service degraded 1 条。
- 修改（契约变更随迁，逐个点名）：`set_approval_mode_persists_to_user_data`（快照+健康位断言）、`set_approval_mode_degrades_to_memory_without_service`（同）、`restore_persisted_approval_mode_reads_back_written_value`（置位断言）、`set_approval_mode_concurrent_writes_keep_disk_equal_to_memory`（快照断言）、`pylonCliService.test.ts`（mock port 快照 + 两分支断言）。

## 与 spec 的偏差

无——按 spec 落地。唯一补充：`dispatcher/{mod,crash_reconnect}.rs` 的 `AppStateHandles` 两处构造点随宏 shared 段新增字段必须显式补齐（spec 未点名，编译期暴露）。

## 未解问题 / 遗留

1. #463 未修 NIT 四项保持原样（issue 范围外）。
2. 实机验收未走查（webview2-acceptance：CLI set → 落盘失败注入的端到端时序无法在单测面构造，真机亦需故障注入工具；行为由三层单测钉住）。
3. identity 写放大/写穿协议整体改造仍为后续阶段（#448 原文，与本 issue 无关）。

## 审查轮（两个独立子 agent 对抗式，用户指令派发）

提交 `3d7b5b68` 落地后派发两个只读子 agent：后端（健康位语义/并发/拦截完备性/wire/测试真实性）与前端（消费方完备性/类型链/兼容破坏面/mock/说明书）。裁决：**双双 PASS WITH CONCERNS，零 BLOCKER**。

### 已修（随批 `33b79882`）

1. **后端 CONCERN-1**：`get_approval_mode` 不持写锁，in-flight set「内存已写、save 未结算」的毫秒级窗口内可返回 `{mode: 新值, persisted: 上次结论}` 的瞬时 stale-true（违反快照自述不变量）。裁决取审查者认可的最轻修法：**doc 承认窗口**（权威消费路径＝set 自身锁内返回的快照——不受影响；事后自愈；查询不值得为毫秒级窗口阻塞在在途 save 上，故不走写锁）。
2. **前端 CONCERN-1**：`typedClients.test.ts:331` 是全仓唯一幸存的旧 wire 形状断言（FakeInvoke 注册裸字符串 `'auto'` + `resolves.toBe`）——透传 client 下测试真实通过、不构成破坏，但会把已不存在的契约固化进测试面。修正：fixture 更新为 `{mode:'auto', persisted:true}` + `toEqual`，顺补 `setApprovalMode` 透传用例（该命令原零测试覆盖）。
3. **前端 NIT-2**：架构参考补 `user_data_load` 保持允许的理由（读不分叉 + 种子探询依赖）。

### 未修 NIT（审查核实无需动）

- 后端 NIT-1：restore Some(mode) 臂的 `store(true)` 在 approval_mode 锁 if-let 内——锁中毒时健康位停留初值 true；启动窗口内中毒不可达（阶段 8b 单线程、命令面未开），纯理论。
- 后端 NIT-2：拦截为 IPC 层约定非结构强制——审查者全仓盘点核实「service.save 调用方仅 permission.rs 与本命令」属实，注释已声明，未来新增调用方需人工复查。
- 后端 NIT-3：Ordering Release/Acquire 对独立 bool 偏强（Relaxed 即足），保守无害。
- 前端 NIT-1：mockTauri 不校验 mode 枚举/set 无状态——浏览器 mock 模式下 App.tsx 跳过该 effect、无生产调用者，纯 demo 保真度。

### 审查轮复验证据

- vitest（typedClients + src/cli + mockTauri）：**4 文件 56 passed / 0 failed**。
- `cargo test --lib permission::tests::set_approval_mode`：3 passed；`cargo fmt --all --check` 干净。
- 审查者独立实测：`bun x tsc -b` 零输出；`src/cli` 4 文件 55 用例全绿（随批修正后 56）。

## 并行交集

本批共享树提交仅含上表 13 文件。#515 的 27 个 store 在途文件、[Codex] 的 `src-tauri/Cargo.toml` 均未触碰、未暂存。全量 vitest 4 红已定位为 #515 施工中间态（被测文件在其在途清单内），非本批引入——合并前请 #515 完工后复跑全量确认。
