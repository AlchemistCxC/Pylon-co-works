# 开发记录：#487 workbench legacy 快照面退役 + #488 纯卫生批七项

- 分支：`kumo/487-488-legacy-sunset-hygiene2`（基于 78d277a2，含 #486 批已入库的声明与 JobObject 提交）
- 提交链：`5bcff216`（#487）→ `ffde0917`（③）→ `38a4a0c2`（④）→ `92d5c41c`（⑥）→ `95180a91`（⑤）→ `6f93902b`+`a7082118`（①+fmt）→ `407bd5f3`（⑦）→ `762bbc1f`（②）→ ci.yml 补步
- 规格：`.agents/spec/487-488-legacy-sunset-hygiene2.md`

## #487 legacy 快照面退役

**改动面**（23 文件，+457/−577，纯减法）：

- `src/domains/workbench/workbenchRuntime.ts`：`WorkbenchRuntimeSnapshot.messages`
  字段删除；五个验收点名标识符（documentFromLegacy / legacyFieldsFromDocument /
  legacyFieldsMemo / runningStateMemo / legacyMessageMemo）连同辅助件（projectLegacyMessages /
  legacyMessageOf / legacyMessagesMemo / RunningState / runningStateOf / legacyDocumentFields /
  documentLegacyDerived + update() legacy 分支与 console.warn）全部退役；
  `documentDerivedFields`（六引用键 memo 保留）承载 document→运行时字段推导。
- 构造契约：initial 强制 `document`；publish 缺席沿用上一份；update() 退化为
  纯字段补丁。LegacyRebuildGuard 守卫主题反转（4 用例数不变）。
- 渲染层：调度器双列表机制退场（7 处 legacy 分支 + D3 注释口径更新）；
  WorkbenchContent viewMessages 纯 document 化（legacy tool 行合并删除）；
  displayGateSignature 去 messages；SolidWorkbenchApp 死导出 previewRenderMessages 删除；
  host port 合成快照的反向投影 documentMessages + memoMapped/ElementMemoSlot 退役
  （第三方 Suite 与内置渲染器同构读 document.messages）。
- 预览面：previewWorkbenchServices 直构 document（文本行→messages、tool 行→
  activities（含 orphan/sequence 必填）、tasks→plan entries）；测试输入全数
  document 化（调度器测试族 snapshot() helper 把 messages 覆盖项路由进 document；
  mount 测试新增 streamInto 助手）。

**验证**：

- `vitest run src/domains`：改造前 **186 文件/1513 用例**、改造后 **186 文件/1513
  用例**，计数一致全绿（删除前后对照即验收判据）。
- 全量 `bun run test`：**662 文件 / 5172 用例通过**（1 skip/1 todo 为预存）。
  renderers 侧净 −1：`streamingDisplayScheduler.test.ts` 的「D3 双列表去重计费」
  用例随机制退役（其守护的分叉源——双列表——已不存在），判据 C 的「同一行只记
  一次账」以单列表等价用例保留。
- `tsc -p tsconfig.json` 与 `tsconfig.solid.json` 均 0 错；`bun run lint` 0 error
  （1 条预存 warning 非本批域）。
- 踩坑记录：fixture shell 测试断言 tool 行可见（'Read'）——预览 document 初版只
  映射文本行而漏 activities，补 tool 行→activities 映射 + plan entries 后复原。

## #488 七项

### ③ search LIKE 通配符转义（bug 修复，行为变化即预期）

- `event_repo/repo.rs::search_hits`：`query.replace('\\',"\\\\").replace('%',"\\%").replace('_',"\\_")`
  后包 `%…%`，三列 LIKE 追加 `ESCAPE '\\'`；instr 偏移仍用原 query。
- 回归测试 `search_hits_escapes_like_wildcards_to_literals`：`%` 只命中字面含
  `%` 的行、`_` 不匹配 `axb`、`\` 字面匹配、混合子串照常。
- 验证：`cargo test -p pylon-session --lib` event_repo 86 过（含新用例）；
  search_hits 族 5 过。

### ④ 阻塞 fs 统一 spawn_blocking

- paths.rs `migrate_appdata_to_portable`（staged 整树复制）、agent_cmds.rs MHTML
  落盘（bytes move 进闭包，byteLength 先取）、workspaces list_workspace_entries
  （目录枚举）——与 workspace_search 同口径。
- 验证：`cargo check -p pylon` 过；`cargo test --workspace --lib` 全绿。

### ⑤ 终态事件单一构造点 + 序列化诊断

- `permission.rs`：`ResolvedInteractionEvent` 枚举 + `resolved_interaction_payload`
  单一构造点；5 处手拼 json! 变体（lib.rs 断线 drain ×2、超时 sweep ×2、
  interaction_route elicitation 完成）全部改走；钉形测试
  `resolved_interaction_payload_pins_both_wire_shapes` 互钉字段集合。
- dispatcher/mod.rs：canonicalEvent `unwrap_or(Null)` → match，失败保留缺列下发
  （单事件载荷缺陷不阻断整帧）+ `tracing::warn!(source, %error, "canonicalEvent
  序列化失败，事件缺列下发")`。
- 验证：`cargo test -p pylon --lib` 971/0。

### ① AppState/AppStateHandles 单源

- `declare_app_state!` 宏：shared（10 字段）/app_only（22 字段）一张表生成
  AppState、AppStateHandles 与 `from_state`。此前「两个结构体定义 × from_state
  拷贝清单」三处人肉同步 → 一处声明。
- 编译期互钉证据（负向验证）：从 shared 表删除 `hook_bridge` 一行 → 2 处编译错
  （AppState 构造缺字段 + Handles 消费点缺字段）；复原后编译恢复。
- 字段文档随表迁移（message_service/event_service 采用两侧文档合并）；
  AppState 字段序变为 shared→app_only（无 derives，无行为影响）。
- 验证：`cargo test -p pylon --lib` 971/0；fmt 干净。

### ⑦ 前端日志统一出口

- 新 `src/domains/diagnostics/frontendLogSink.ts`（端口：installFrontendLogSink /
  logWarn / logError；缺省 console；出口抛错 try/catch 静默回落 console）+
  `src/infrastructure/tauri/frontendLogSink.ts`（IS_TAURI 守卫；invoke
  push_frontend_log；detail 并入 message，Error 取 message；invoke 失败/限流静默
  回落 console）+ main.tsx 顶部接线（先于各桥安装）。
- 12 处 console 收敛：identitySessionActions ×2 / identityProfileActions ×1 /
  hookBridgeDispatcher ×3（英文→中文）/ skinRuntimeServices ×1 / pylonCliBridge ×1
  （英文→中文）/ App.tsx ×3；workbenchRuntime.ts:195 已随 #487 消失（13−1）。
- main.tsx 自身 4 处启动期 console 保留（早于接线/桥失败诊断，不在 issue 清单）。
- 测试：frontendLogSink 端口 2 用例（console 透传 + 换装/故障回落）。
- 验证：`vitest run src/domains src/infrastructure src/cli src/app` 255 文件/2047
  用例全绿；check:maintenance exit 0；lint 0 error。

### ② await-holding 豁免治理（豁免面 26 → 0，wrapper 36 处）

- 新 `pylon-foundations/src/await_guard.rs`：`HeldAcrossAwait<T>` newtype
  （Deref/DerefMut 透传，无 Drop 实现——锁获取/释放时序零变化，这是唯一允许
  的用法：包住既有守卫绑定，不改加锁/放锁语句结构）。
- 26 处 `#[allow(clippy::await_holding_invalid_type)]` 全数删除（锁序注释保留为
  普通 `//` 注释——「剩余每处有锁序注释」判据达成）；30+ 守卫绑定（clippy
  逐点报出，含同函数多锁：lifecycle/mod ×6、control ×3、wait ×3）包裹
  `HeldAcrossAwait::new`。pylon-acp/client.rs（Mutex<Receiver> 持锁消费）与
  平台测试（prompt_gate）一并收口。
- 机械保障：`scripts/check-await-holding.mjs`——规则 1 全域禁裸 allow；规则 2
  `HeldAcrossAwait::new` 出现点与 INVENTORY 对账（17 文件 36 处，含定义文件
  自示例 1 处），增删必须同步登记。并入 `check:clippy` npm 链与 CI rust-clippy
  job（ci.yml 补一步）。
- clippy.toml：六条目补 `allow-invalid = true`（pylon-foundations 无 tokio 依赖图
  时 clippy 1.98 发「不可达类型」元告警；该旗只静默元告警，lint 本身在类型
  可达的 crate 照常生效）。
- 前后对照：豁免 26 → **0**；`bun run check:clippy` exit 0（基线 `added: []`
  ×6 crate + 对账通过）。
- 踩坑：await_guard 初版 `&*self.0` 撞 `clippy::explicit_auto_deref`、函数内
  `use std::ops::Deref as _` 撞 `unused_imports`（泛型约束已让方法可调）——
  改为裸方法调用 `self.0.deref()` 后全绿。

## 门禁汇总

- 前端：全量 vitest 662 文件/5172 过；tsc ×2 0 错；lint 0 error；check:maintenance 0。
- Rust：`cargo test --workspace --lib` 9 目标 **1670 过 / 0 挂**（pylon 971、
  pylon-session 216、pylon-acp 186、pet-core 137、pylon-core 93、其余合计）；
  `bun run check:clippy` exit 0（基线零新增 + await-holding 对账通过）；
  `cargo fmt --all --check` 干净。
- 环境事故与处置：施工中 G: 盘两次写满（并行会话注明）——删
  `target/debug/incremental`（9.1GB）+ `cargo clean -p pylon -p pylon-foundations`
  （陈旧 rlib 一度造成 E0432 假象）后复绿；全程 `CARGO_INCREMENTAL=0`。

## 遗留与移交

- `WorkbenchRuntimeSnapshot.document` 仍为可选类型（运行时恒存的不变式靠构造
  契约维持）——收成必填会波及调度器测试字面量与全部 `document?.` 链，建议随
  ADR-0035 Solid 化批次再收。
- `snapshot.tasks` 仍是 legacy 形状字段（PlanEntry），有真实读写面，不在 #487 面；
  若后续退役属新 issue。
- host port 对第三方（仓外）Suite 而言 `.messages` 已消失——仓内零读者，仓外
  插件生态若有依赖属发行说明事项（ADR-0035 前后一并公告）。
- #486 项3（dispatcher/lib.rs/session 拆分）与本批在 lib.rs/dispatcher/session
  有文件域重叠：本批先行入库，项3 请基于本基线机械合并（await_guard 导入行与
  HeldAcrossAwait 包裹随函数走）。
