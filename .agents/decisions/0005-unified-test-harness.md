# ADR-0005 测试大一统基建：Rust 假 ACP agent、统一 harness 与 CI 门禁集成

- **日期**：2026-09-16
- **状态**：提议（方向经用户四项决策裁决，待实施验证后转"已采用"；规格见 `.agents/spec/issue-106-unified-test-harness.md`）

## 背景与约束

后端集成测试设施已具雏形（`test_utils.rs` 的 fake agent + TestStateBuilder + tauri MockRuntime），但有四个结构性缺口：

1. 假 ACP agent 是 5+ 份**内嵌 Python 脚本**（`test_utils.rs:70-109`），依赖宿主解释器与 locale（CI runner cp1252 踩坑已记录在 `fake_acp_agent_with` 注释），CI 因此显式 skip 三个集成测试文件（`.github/workflows/ci.yml:70`）——本地与 CI 测试集不一致；
2. b10 / b11 / auto_reconnect / p1_wire 各自拼 MockEnv，无共享 harness，新集成测试边际成本高；
3. `run()`（`lib.rs:692`）零测试路径：全局注册、AppState 组装、setup 管道全部在测试之外，`TestStateBuilder` 与 run() 靠人肉同步（E18 纪律，`test_utils.rs:113-122` 自认漂移风险）；
4. 前端 invoke 命令名与 `generate_handler` 注册表（`lib.rs:877-989`，约 150 命令）无贯通校验。

约束：不改生产行为；不弱化既有门禁；CI 为 windows runner；发行包不可携带测试用二进制。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| 进程内 mock transport（`AcpClient` 引入 transport trait） | 要动生产代码接缝；且真子进程语义——EOF 崩溃检测、`ManagedChild`/Windows Job Object 进程树回收——失去覆盖 |
| 收敛 Python 共享脚本（保留子进程形态） | 改动最小，但 CI 对宿主解释器/locale 的不可复现依旧，三个集成测试永远进不了 CI，"大一统"缺一角 |
| WebDriver / 真实 WebView2 e2e | 成本最高；前后端接缝已有 `check:acp-shadow`、前端契约测试与 `FakeInvoke`/`FakeEventBus` 注入缝垫住，收益不成比例，明确不做 |

## 决定

1. **假 agent = feature-gated Rust bin**：`[features] test-agent` + `[[bin]] pylon-fake-agent（required-features）`，场景旗标化（crash/stream/permission/replay/trace/id-mode…）覆盖现全部 Python 脚本能力；正常构建与发行包不含该 bin。
2. **统一 `test_harness` 模块**（cfg(test)，吸收 `test_utils.rs`）：`boot → 挂假 agent → 驱动 command → 事件/持久化/wire 三路证据`；b10、b11、auto_reconnect、p1_wire（含 obs03 末节）、golden trace **全量迁移**，断言逐条保持。
3. **`run()` 可测化提取**（行为保持）：全局注册 / AppState 组装 / setup 管道三个函数；`TestStateBuilder` 默认值与 run() 同源，E18 人肉同步消灭。
4. **IPC 静态契约门禁 `check:ipc`**：`generate_handler` 注册表 ↔ 前端 invoke 调用面双向比对，挂 `check:frontend` 链。
5. **CI 解除 skip**：`ci.yml:70` 去掉 `--skip`，rust job 前置 `cargo build --bin pylon-fake-agent --features test-agent`。

## 后果

- 正面：本地与 CI 测试集一致；假 agent 输出确定性（serde_json 结构体序，无解释器/locale 变量）；新集成测试边际成本降到"一个 boot + 若干断言"；AppState 构造单一来源；IPC 接缝有常驻门禁。
- 负面：多一个 feature-gated bin 的维护面；`check:ipc` 是静态解析，`#[tauri::command(rename)]` 类特例需人工豁免清单；`run_setup_pipeline` 的测试需驱动 tauri path API（mock app 深度依赖）。
- 风险：golden trace 基线要求 bin 与 Python 脚本响应逐字段一致（验收以两遍重生成逐字节比对兜底）；p1_wire 五路证据在 CI runner 首次真实执行可能暴露时序问题（预算一轮调稳，不回退 skip）。

## 证据

- `src-tauri/src/test_utils.rs:24-109`（Python 探测与 fake agent 构造、cp1252 注释）、`:113-243`（E18 纪律）
- `.github/workflows/ci.yml:66-70`（skip 及理由注释）
- `src-tauri/src/lib.rs:692`（run）、`:706-727`（注册镜像源）、`:877-989`（generate_handler）、`:990-1090`（setup 管道）
- `src-tauri/src/acp/golden_trace_tests.rs:33-46`（10 场景）+ `scripts/generate-acp-golden-trace.mjs`（确定性比对）
- 集成测试现状：b10=1 / b11=11 / auto_reconnect=5 / p1_wire=19（obs03 已并入 `p1_wire_regression_tests.rs:665` 末节）
