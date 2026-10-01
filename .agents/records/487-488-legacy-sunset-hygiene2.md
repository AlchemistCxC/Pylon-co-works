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

- 新 `src/contracts/frontendLogSink.ts`（端口：installFrontendLogSink /（初版落 `src/domains/diagnostics/`，合并轮起上移 contracts，见文末「合并轮」）
  logWarn / logError；缺省 console；出口抛错 try/catch 静默回落 console）+
  `src/infrastructure/tauri/frontendLogSink.ts`（IS_TAURI 守卫；invoke
  push_frontend_log；detail 并入 message，Error 取 message；invoke 失败/限流静默
  回落 console）+ main.tsx 顶部接线（先于各桥安装）。
- 12 处 console 收敛：identitySessionActions ×2 / identityProfileActions ×1 /
  hookBridgeDispatcher ×3（英文→中文）/ skinRuntimeServices ×1 / pylonCliBridge ×1
  （英文→中文）/ App.tsx ×3；workbenchRuntime.ts:195 已随 #487 消失（13−1）。
- main.tsx 自身 4 处启动期 console 保留：不在 issue 清单的 13 处之内（范围纪律；接线 `installTauriFrontendLogSink()` 本身已是 main.tsx 模块体第一条语句，这 4 处实际晚于它——审查轮修正措辞）。
- 测试：frontendLogSink 端口 2 用例（console 透传 + 换装/故障回落）。
- 验证：`vitest run src/domains src/infrastructure src/cli src/app` 255 文件/2047
  用例全绿；check:maintenance exit 0；lint 0 error。

### ② await-holding 豁免治理（豁免面 26 → 0，wrapper 36 处）

- 新 `pylon-foundations/src/await_guard.rs`：`HeldAcrossAwait<T>` newtype
  （Deref/DerefMut 透传，无 Drop 实现——锁获取/释放时序零变化，这是唯一允许
  的用法：包住既有守卫绑定，不改加锁/放锁语句结构）。
- 基线口径（审查轮修正）：代码内 `#[allow(clippy::await_holding_invalid_type)]`
  实为 **28 处**（issue 原文与首批提交写 26，系审计口径偏差；另 4 处为文档中的
  文字提及）。28 处全数删除（锁序注释保留为普通 `//` 注释——「剩余每处有锁序
  注释」判据达成）；clippy 逐点报出的守卫绑定（28 个 allow 位点下实际 **35 个**
  守卫——同函数多锁逐守卫拆账：lib.rs 1→2、control 2→3、wait 1→3、lifecycle/mod
  3→6）包裹 `HeldAcrossAwait::new`。pylon-acp/client.rs（Mutex<Receiver> 持锁
  消费）与平台测试（prompt_gate）一并收口。**豁免机制替换 28→0，显式声明点
  28→35**——验收判据「显著少于 26」按字面未达成，达成的是「机制替换 + 全量
  显式声明 + 机械对账」，已在 issue 评论区声明该口径差。
- 机械保障：`scripts/check-await-holding.mjs`——规则 1 全域禁裸 allow（正则
  覆盖合并列表/cfg_attr/内属性变体）；规则 2 按 `HeldAcrossAwait` **类型名**
  计数（含 use 行，防 `use ... as X` 别名绕过）与 INVENTORY 对账（17 文件 57 处，
  审查轮从 `::new` 计数 36 处加固），增删必须同步登记。并入 `check:clippy`
  npm 链与 CI rust-clippy job（ci.yml 补一步）。
- clippy.toml：六条目补 `allow-invalid = true`（pylon-foundations 无 tokio 依赖图
  时 clippy 1.98 发「不可达类型」元告警；该旗只静默元告警，lint 本身在类型
  可达的 crate 照常生效）。
- 前后对照：裸 allow 豁免 **28 → 0**（见上口径修正）；`bun run check:clippy`
  exit 0（基线 `added: []` ×6 crate + 对账通过）。
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

## 审查轮（三个独立子 agent 并行，用户指令派发）

结论：#487 批 APPROVE WITH NITS；①③④⑤⑥ 批 APPROVE WITH NITS（2 MINOR）；
②⑦ 批 REQUEST CHANGES（1 MAJOR 文档失同步）。已处置：

- **[MAJOR·已修] dev-standards.md:78 仍教「函数级 #[allow]」**——与本批新门禁
  正面矛盾。已改述为 HeldAcrossAwait 收口 + 对账清单口径；维护地图同步补
  check-await-holding 门禁链描述、`await_guard.rs` 单源行、frontendLogSink 登记。
- **[MINOR·已修] ⑤ 注释错述基线**：原 `unwrap_or(Null)` 是**列值为 null** 下发
  （前端 cursor 对 null 归一失败会整帧丢弃并报错），不是「缺列」；本批改为缺列
  干净下发 + warn。dispatcher/mod.rs 注释已改述，并在 PR/issue 显式声明为 ⑤
  红线的预期内例外（该分支当前不可达，CanonicalEventRow 全字段可序列化）。
- **[MINOR·已修] ④ MHTML JoinError 早退**：`?` 绕过 `cx.error(denial(...))`
  信封出口。已并入 save_result 的 Err 流，与 fs 失败同出口。
- **[MINOR·已修] 基线豁免 26→28 口径**：见 ②节修正；issue 评论区已澄清
  （allow 28→0 / 显式声明点 28→35 双口径）。
- **[MINOR·已修] check 脚本加固**：规则 1 改正则（覆盖合并列表/cfg_attr/内属性）；
  规则 2 改按类型名计数（防 use 别名绕过）；删死代码 replace。
- **[MINOR·已修] #487 守卫不变式收窄**：`PreviewWorkbenchRuntime.update` patch
  类型收窄为 `Omit<…, 'revision' | 'document'>`（守卫测试头注承诺的不变式落到
  类型层）；`agentWorkbenchSession.updateRuntimeState` 的 document 剥离防御位
  随之成为死代码并删除（旧逻辑本就是丢弃 patch 里的 document，语义等价）。
- **[NIT·已修]** ③ 注释四处 #487→#488 笔误；frontendLogSink detail 格式化
  （对象 JSON.stringify 回落 String，不再 `[object Object]`；console 回落传原始
  (message, detail)）；EMPTY_MESSAGES 冻结；hostPortSolidServices「legacy runtime
  arrays」过时注释；DisplayGate 测试头注释。
- **[NIT·记录不改]** ⑥ 提交信息写「12 文件」实为 11（历史不重写，本记录更正）；
  paths.rs `migration_available` 的两次目录扫描仍在 async 线程（存量、量小，
  移交后续）；超长 query LIKE pattern 阈值因转义减半（病态输入理论项）；
  tauri frontendLogSink 实现侧零测试（端口层 2 用例已钉行为）。
- 审查确认无问题项：② 锁时序零变化逐异形点核验成立（wait.rs 两处/client.rs
  临时守卫/control.rs Deref 均等价）；① 宏表 shared/app_only 与基线逐字段一致
  无错分；③ 转义在真实 SQLite 上验证（含 NOCASE 叠加）；#487 推导等价性、
  漏改 grep 零残留、测试断言未弱化（净 −1 即 D3 用例）。

审查轮门禁复跑：`bun run check:clippy` exit 0（加固后对账 17 文件/57 处）、
tsc ×2 0 错、`cargo check -p pylon` 过、check:docs/maintenance 过。

## 合并轮（PR #502 冲突处置，两批 merge）

main 在本分支施工期间连续吸收 #482/#483（便携唯一存储 + 宠物 UI 全链删除）、
#485、#486 全部七项、#489/#490/#491，PR 两度 CONFLICTING。两批 merge（c4e193bb、
5dd4ebd6 + 本笔 allowlist/记录修正）：

- **批一（#482/#483）**：paths.rs 以 main 为准——迁移链整链删除使 #488④ 的
  `migrate_appdata_to_portable` spawn_blocking hunk **随函数消亡**（批④剩两处：
  MHTML 落盘、list_workspace_entries，验收面不变）；L.md 按声明自带指令撤下
  已合并的 #482/#483 条目；firstPartyStyleOwnership.test 双删合并（workspace 6
  = −PrismSheet/#484、renderers 6 = −PetCompanion/#483）。
- **批二（#486 七项等）**：WorkbenchContent.solid.tsx 保留 #487 纯 document 版
  viewMessages（项4 拆分基线早于 #487，其旧 legacy 版被 main 带回；`displayDocument`
  已随项4 拆分退役，改用 `document()`）；维护地图把 #488② 门禁尾与 #489 分层
  规则段按语义拼接。#486 项3 的超长函数拆分在 lib.rs/dispatcher/session 与本批
  HeldAcrossAwait 包裹**自动合并成功**（项3 按交接注记基于本批基线合并）。
- **#489 新分层门禁反噬处置**：新规则「infrastructure → domains 运行时值禁止」
  命中本批⑦的 3 条 import（hookBridgeDispatcher / skinRuntimeServices /
  tauri/frontendLogSink → 端口）。**端口自 `src/domains/diagnostics/` 上移
  `src/contracts/frontendLogSink.ts`**（契约层各层可自由消费，测试随迁，
  12 处消费点 import 重写），分层门禁 857 文件 11 规则零越界。
- **check-runtime-boundaries allowlist 补登记**：`infrastructure/tauri/frontendLogSink.ts`
  的 direct invoke 按 hookBridgeDispatcher 先例登记（CI check:solid 首跑暴露，
  本地此前只跑了 layer 门禁漏过——教训：合并后应跑完整 `bun run check:solid`）。
- 合并后全门禁：Rust workspace lib 1664/0（#482/#483 删测试净 −6）、vitest
  661 文件/5169 过、check:clippy 0（对账 57 处不变）、check:solid 全链 0、
  fmt/tsc×2/check:docs 0。
