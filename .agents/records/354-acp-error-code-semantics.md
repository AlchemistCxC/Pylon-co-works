# Dev Record — #354 ACP 错误码语义（fs/terminal 负路径 + AuthRequired 消费）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：[#354](https://github.com/AlchemistCxC/Pylon-co-works/issues/354)
- 分支：`kumo/prometheus`
- 提交范围：`2cf049d9..本次 head`
- 日期：2026-09-26

## 目标与范围

修复 ACP 错误码语义两处丢失：

1. **fs/terminal 执行错误压平**：宿主对 fs/terminal 请求的所有失败此前一律回
   `-32602 InvalidParams`，「文件不存在」「沙箱拒绝」与「参数本身坏」不可区分。
   按官方 schema 细化：缺失 → `resource_not_found`（-32002，`data:{uri}`）；沙箱
   拒绝保持 -32602 但 message 加 `sandbox:` 稳定前缀；未知 host 工具子方法 →
   -32601（官方基线）。**超时/超限/参数缺失/序列化失败的 wire 输出逐字不变**。
2. **agent 侧 `-32000 AuthRequired` 未消费**：`rpc_failure_details` 新增
   `AuthRequired` 分类（按结构化 code 一票判定，置于文本启发式之前）；
   `AgentConnectFailure::initialize` 对远端 -32000 给稳定码 `agent_auth_required`
   （cause 封闭词表与前端码表已登记）。

**不做**：`pylon-acp/{engine,process,terminal_runtime}.rs` 零改动（#361-363 在途域；
terminal registry 的 `Result<_, String>` 契约不动，dispatcher 只按其稳定文案分类）；
`PylonError`/session-new 错误面重构（issue 建议未及）；UI 登录行动指引与
`authenticate` 调用链（issue 明示后续跟进）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `pylon-acp/src/fs_policy.rs` | `FsFailure` 三分类（NotFound{uri}/SandboxDenied/Other）+ `message()`；`ensure_path_allowed`/`check_read`/`check_write` 类型化；**先沙箱判定、后存在性判定**（最深存在祖先做 canonical 包含检查）；写模式仅允许目标自身缺失（立即父目录须存在），深缺失 → NotFound | 修改 |
| `pylon-acp/src/file_system_runtime.rs` | `read_text_file`/`write_text_file` 返回 `FsFailure`；io 层 NotFound 单列（`io_failure`），超时/超限归 Other | 修改 |
| `src-tauri/src/dispatcher/mod.rs` | `FsToolError` 错误面 + `host_fs_error_response`/`host_terminal_error_response` 纯函数映射 + `respond_tool_error`（data 经官方 SDK `Responder::respond_with_error` 直发）；terminal create 早退臂不变 | 修改 |
| `pylon-acp/src/error.rs` | `RpcFailureKind::AuthRequired`；`rpc_failure_details` 的 -32000 结构化判定；`initialize` 的 `agent_auth_required` 稳定码；两个新测试 | 修改 |
| `pylon-acp/src/cause.rs` | 封闭词表测试登记 `agent_auth_required`（透传 + 诊断兜底 action） | 修改 |
| `src-tauri/src/acp/tests.rs` | `rpc_failure_kind_distinguishes…` 契约修正：-32000 样本改判 AuthRequired，文本/data 启发式载体换 -32602 | 修改 |
| `src/app/errorCodeExplanations.ts` + `__tests__` | 追加 `agent_auth_required` 词条（登录向 hint）与期望码 | 修改 |
| `docs/说明书/Pylon-项目架构参考.md` | #316 段尾补 #354 wire 语义 | 修改 |
| `docs/说明书/Pylon-模块维护地图.md` | Native ACP 行补 FsFailure/AuthRequired 不变量 | 修改 |

## 方案要点

1. **`FsFailure` 落在 `fs_policy.rs`（pylon-acp），wire 映射只在 dispatcher**——
   pylon-acp 不依赖 wire 码，宿主边界是唯一翻译点；pylon-acp 171 个既有单测全部
   继续按新签名运行。
2. **先沙箱、后存在性**（安全修正）：roots 外路径无论存在与否恒 `SandboxDenied`。
   初版实现曾把「roots 外 + 父目录缺失」判成 NotFound，构成沙箱外路径的**存在性
   探测预言机**；重写为对最深存在祖先做 canonical 包含检查后再回答存在性。
3. **写新文件的合法缺失**：写模式下目标自身缺失且立即父目录存在 → `Ok`（可创建）；
   中间目录缺失 → NotFound（由 policy 分类，IO 兜底同样归 NotFound）。
4. **data 载荷不经 engine.rs**：`ResponderHandle::respond_error` 不带 data；为避让
   #363 在途的 engine.rs，dispatcher 经 pub 的 `pending_requests` 直取官方 SDK
   `Responder` 调 `respond_with_error(Error::new(..).data(..))`（handle 类型经推断
   引用，未扩大 pylon-acp 引擎面）。
5. **-32000 一票判定**：协议已定义该码语义，agent 误用它表其它含义属协议违规，
   文本启发式让位——即使 message 像 session 缺失也判 AuthRequired
   （`acp/tests.rs` 旧样本按新契约修正，启发式样本换 -32602 载体保留）。
6. **终端分类是文案耦合点**（如实记录）：`terminal_runtime.rs`（#363 域）返回裸
   String，dispatcher 按 ` not found` / `unsupported terminal method` 稳定文案分类；
   dispatcher 侧纯函数测试用真实文案钉住，registry 文案若变此处红灯。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `cargo test -p pylon-acp --lib` | ✅ **171 passed; 0 failed**（新增 fs_policy 三分类 + runtime 分类 + AuthRequired/稳定码等 5 用例） |
| 前端 `errorCodeExplanations.test.ts` + `acp-vocabulary.test.mts` | ✅ **15 passed**（词表门禁三组比对不受影响） |
| `cargo check -p pylon --lib`（非测试目标） | ✅ 通过（`tauri::Manager` 警告来自 #361/#363 在途文件，非本批） |
| dispatcher 纯函数映射 / acp 契约修正测试可运行 | ⚠️ 编译确认通过（`cargo check --tests` 仅余 #363 的 8 个错误，全在 `session_expiry_platform_tests.rs`），**运行验证被 #363 在途编译态阻塞**——其收工后 `cargo test -p pylon --lib dispatcher::tests acp::tests::rpc_failure_kind` 即可复核 |
| 说明书同步 | ✅ 架构参考 + 模块维护地图各一处 |

## 测试处置

- 新增：`fs_policy::failures_classify_not_found_denied_and_never_probe_outside_roots`、
  `file_system_runtime::runtime_classifies_missing_as_not_found_and_outside_as_denied`、
  `error.rs::rpc_failure_kind_classifies_auth_required_by_wire_code_before_text_heuristics`、
  `error.rs::initialize_maps_remote_auth_required_to_a_stable_code`、
  `cause.rs::auth_required_failure_is_a_registered_connect_cause_code`、
  `dispatcher::tests::host_fs_errors_map_to_official_wire_semantics`、
  `dispatcher::tests::host_terminal_errors_map_not_found_and_unsupported_method`。
- 修改：`acp/tests.rs::rpc_failure_kind_distinguishes_missing_session_from_method_and_transient_errors`
  （-32000 样本 -32000→AuthRequired 契约变更；-32602 载体保留启发式覆盖）。

## 证据

- `cargo test -p pylon-acp --lib` → `171 passed; 0 failed`（2.03s）。
- `bun run test -- src/app/__tests__/errorCodeExplanations.test.ts scripts/acp-vocabulary.test.mts` →
  `Tests 15 passed (15)`。
- `cargo check -p pylon --lib` / `--tests`：非测试目标干净；测试目标仅余 #363 在途
  文件（`session_expiry_platform_tests.rs`）的 8 个既有错误，本批文件零错误。
- 中途曾有一次真实回归：初版把写新文件误判 NotFound（4 个既有测试红灯），即模拟
  即修（见方案要点 3），复读全绿。

## 与 spec 的偏差

1. `respond_tool_error` 的签名从「拿 `ResponderHandle`」改为「拿 `AcpLock`」：
   `ResponderHandle` 未在 pylon-acp 根导出（engine 模块私有），按推断引用更省事
   且避免为可见性动 lib.rs。
2. 新增「先沙箱后存在性」的重写与 -32601 未知子方法映射——前者是初版实现的安全
   缺陷自查发现（spec 未预见的语义细节），后者在 spec 范围内（spec 已列）。

## 未解问题

- 无语义遗留。可选后续（不在本 issue 范围）：`authenticate` 调用链、登录 UX、
  session/new 失败面在 PylonError 边界的码透传。

## 并行交集

本批文件与 L.md 在途的 #361-363（pylon-acp/{process,engine,terminal_runtime}.rs、
pylon-core/**、main.rs、logging/**、session/{expiry,…}）、#371（pack_release/清单/
docs-site）、#357（errorCodeExplanations 的删词条/提常量区段）域不重叠；其中
前端码表为**纯追加一行**（与 #357 区域不相邻）。共享构建受 #363 在途编译态影响：
`cargo test -p pylon --lib` 在其收工前无法运行（本批 pylon 侧新测试的运行验证随
其收工复核）；`pylon-acp` 与前端门禁不受影响，已全绿。
