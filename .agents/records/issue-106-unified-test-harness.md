# Dev Record — #106 后端大一统测试基建（统一 harness、Rust 假 ACP agent、IPC 接缝校验与 CI 解 skip）

## 2026-09-16 continuation

- P5：继续沿用本分支现有实现，auto_reconnect、b11_inject、model_switch 与 b10 均进入 `tests/integration.rs` 单一 integration target；`cargo test --manifest-path src-tauri/Cargo.toml --tests --features test-agent` 实测 21 个集成测试、1072 个 lib 测试及 fake-agent/bin 测试全部通过。
- P4：尝试 projects 聚合（scripts=node、src=jsdom、isolate=false），实测触发大量跨文件 localStorage/初始化污染失败，已回退到原配置；P4 仍未验收，不能用不稳定结果冒充完成。
- 后续按环境拆成 `scripts`、`frontend`、`solid` 三个 Vitest project；普通前端测试共享进程，Solid 测试保持 isolate（其 fake-clock/module 状态要求逐文件初始化）。代表性 React 测试通过；Solid scheduler 测试仍有既有时钟断言失败，需后续单独修复，不能归因于 projects 配置。

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：[#106](https://github.com/AlchemistCxC/Pylon-co-works/issues/106)
- 分支：`Ru5t/issue-106-test-harness`（**本地分支，未推远端**——用户指示因不可抗力仅本地提交；PR 待恢复后补开）
- 提交范围：`73b1bf00`（基线 = 3aa2e5e4 + main 合并节点）..`HEAD`
- 日期：2026-09-16

## 目标与范围

后端在一个共享 harness 上模拟「无 UI 的整个产品运行」（mock app + 完整 AppState + 真子进程假 ACP agent + 真实 dispatcher 泵 + in-memory SQLite + wire 观测），且链路在 CI 可复现（去 Python）。原规划 P0→P7 八阶段一个大 PR。

**本期实际落地**：P0、P1、P2（核心 + 冒烟）、P3a、P3b、P6、P7。**未落地（遗留）**：P4（前端 vitest projects 聚合）、P5（集成测试物理抽离 `tests/integration.rs`）——理由与现状见「与 spec 的偏差」。

## 改动清单

| 文件/区域 | 范围 | 性质 |
| --- | --- | --- |
| `src-tauri/Cargo.toml` | `[workspace]` members + resolver 2；`[features] test-agent`；`[[bin]] pylon-fake-agent`（required-features） | 修改 |
| `src-tauri/{pylon-core,pylon-foundations,pet-core}/Cargo.lock` | 删除（单锁） | 删除 |
| `src-tauri/src/bin/pylon-fake-agent.rs` | 新增：36 场景旗标化假 ACP agent + 11 单测 | 新增 |
| `src-tauri/src/test_utils.rs` | Python 探测链删除；`fake_acp_agent` 改旗标构造；`fake_agent_bin`/`fake_acp_agent_stub`；TestStateBuilder 改经 `build_app_state` | 修改 |
| `src-tauri/src/test_harness.rs` | 新增：TestHarness::boot + 三路证据 + TempPath + 冒烟测试（2 测） | 新增 |
| `src-tauri/src/lib.rs` | `install_process_registrations` / `AppStateParts`+`build_app_state` / `run_setup_pipeline` 三段提取；`mod test_harness` | 修改 |
| 22 处脚本字面量、约 60 个调用点 | 14 个文件（golden/acp tests/b10/b11/p1_wire/auto_reconnect/permission/session 族/lifecycle/instance_registry/plugin_process/expiry 等）脚本→场景旗标，断言不变 | 修改 |
| `src-tauri/pylon-core/src/agent_diagnostics.rs` | `report_from_parts` 判定核提取；环境依赖测试封闭化 +1 测试 | 修改 |
| `examples/process-plugins/process.json-rpc-echo/` | service.py→service.mjs（Node）；三平台 wrapper 改 node | 修改 |
| `scripts/check-ipc-contract.mts` | 新增：IPC 双向静态契约门禁 + `--self-test` | 新增 |
| `scripts/check-clippy-baseline.mjs` | `--package` 过滤（workspace 级 json 按包拆分比对） | 修改 |
| `package.json` | `check:rust` workspace 形态 + bin 前置；`check:ipc` 入 `check:frontend` 链 | 修改 |
| `.github/workflows/ci.yml` | 测试步 workspace 化 + 解 skip；fmt/clippy workspace 单跑；rust-cache + bun cache；失败证据包 + upload `if: always()` | 修改 |
| `.github/workflows/cargo-mutants.yml`、`.github/dependabot.yml` | 新增（P7.2/P7.3） | 新增 |
| `src-tauri/.cargo/config.toml` | rust-lld + line-tables-only（P6） | 新增 |
| `docs/说明书/Pylon-项目架构参考.md`、`Pylon-模块维护地图.md` | 常用命令/门禁表述同步 workspace 化 | 修改 |
| `.agents/decisions/0005-unified-test-harness.md` | 状态提议→已采用（部分） | 修改 |

## 方案要点

1. **workspace 化（P0）**：members 4 crate、resolver 2、删 3 子锁。feature unification 实测：src-tauri 1089 测 workspace 化前后**完全一致**。clippy 单次 `--workspace` 跑完，一份 json 按 `package_id` 过滤（脚本新增 `--package`）后逐 crate 对基线。
2. **假 agent bin（P1）**：单一 bin 覆盖全部 22 份脚本语义，36 场景 + 跨场景旗标（trace-file/trace-mode/permission-id+params/barrier/stderr-marker/chunks…）。关键保真点：chunk content **只有 `text` 键**（原脚本无 `type`）——golden 基线逐字节一致的前提。bin 经 `current_exe()` 祖先目录定位（`PYLON_FAKE_AGENT_BIN` 覆盖）；**测试步必须先构建 bin**（stale bin 是本阶段主要坑，已写进 CI 注释）。
3. **plugin_process 也脱 Python**：service.py 的 8 方法协议（echo/slow/armStubborn/crash/flood/spawnChild）实现为 bin 的 `plugin-fixture` 场景，孙进程 = 自我再执行 `hang` 场景；示例插件同步改 Node。
4. **pylon-core 环境依赖测试封闭化**：`unavailable_shell_path…` 测试原对比真实注册表 PATH 与进程 PATH（Git Bash 下必挂）——提取 `report_from_parts` 纯判定核后注入输入，另补「真实差照报」对照测试。
5. **run() 三段提取（P3a）**：`install_process_registrations`（幂等，test_state_with_acp 手工镜像退役）；`build_app_state`（单一构造点，E18 退役；TestStateBuilder 测试专属字段在构造后覆盖）；`run_setup_pipeline`（setup 闭包 ~450 行整体搬移，Wry 具体签名——BrowserManager 深度依赖具体 Runtime，泛型化级联过宽，故不做 mock 驱动）。
6. **test_harness（P2）**：`boot()` 全 async（tokio 测试内禁 block_on）；事件捕获按 7 个关键事件名挂 listen；三路证据 = events/journal/wire。
7. **时钟注入点查证（验收 19）**：`Timestamp::now()` 生产代码 26 处散布调用，入口不收敛 → 按 spec 预案**降级为编写约定**（新增保留期/过期类测试用 `Timestamp::new` 显式时刻），查证结论写入 harness 模块文档。
8. **check:ipc（P3b）**：未注册方向用严格 invoke 正则（排除插件命令门面与合成夹具——它们的命令名属其他命名空间）；零调用方向用「命令名作为任意字面量出现」宽匹配（fetchPet/call/transport 等本地转发包装众多，宁可漏报不误报）；豁免清单 52 项逐项注明性质（CLI/hook 桥 6 + Prism 历史面 39 + 调试面 5 + 旧枚举 1）。

## 验收标准与结果（19 条完整对照）

| # | 验收项 | 结果 |
| --- | --- | --- |
| 1 | Python 假 agent 脚本字面量清零 | ✅ 22 处全删；`grep python src-tauri/src` 剩余命中逐条核对均为非 fake agent 用途（hermes wrapper 字符串夹具 / agent_config YAML 样例 / 注释） |
| 2 | 无 python/py 干净 shell 全绿 | ✅ 受限 PATH（确认无 python/python3/py）`cargo test --workspace --lib --features test-agent` 全绿：pylon 1089 + pylon-core 93 + foundations 61 |
| 3 | CI 去 skip | ✅ ci.yml 测试步无 `--skip`；⚠️ CI 运行验证待 PR（本地分支未推） |
| 4 | golden 基线行为保持 | ✅ `generate-acp-golden-trace.mjs --check` PASS（两遍逐字节一致 + 与提交基线 10/10 一致）；`check:acp-shadow` ok |
| 5 | check:ipc 通过 + 负向注入 | ✅ 绿（211 注册/143 调用/52 豁免）；删 `send_message` 注册实测判红并列出引用文件 |
| 6 | TestStateBuilder 与 run() 同源 | ✅ 单一构造点 `build_app_state`；E18 注释改写；镜像删除；2 个回归测试 |
| 7 | harness 冒烟三路断言 | ✅ `boot_prompt_produces_journal_events_and_wire_evidence` |
| 8 | 迁移断言等价（--list 对比） | ✅（P1 语义保持）— `cargo test --lib` 计数 1089→1093（仅新增，无改名/丢失）；P5 物理迁移未做，见偏差 |
| 9 | 默认产物不含 pylon-fake-agent | ✅ `cargo build --bin pylon-fake-agent`（无 feature）报 required-features 错误；⚠️ release.yml/发行包验证待 PR |
| 10-12 | vitest projects / isolate 三轮全绿 / coverage -40% | ❌ 未落地（P4 遗留）；基线实测已记录：570 文件 3789 测 129s，setup+environment 占总工作量 ~90% |
| 13 | 集成测试抽离 tests/ | ❌ 未落地（P5 遗留）；门面地基已就绪（harness 三路证据 + TempPath） |
| 14 | P6 rust-lld/line-tables-only/缓存 | ✅ config.toml 落地；本机热增量 touch lib.rs 重编译+链接 **9s**（验收 ≤15s）；rust-cache/bun-cache 进 ci.yml；⚠️ CI 墙钟 -40% 与缓存命中待 PR 日志判定 |
| 15 | P0 workspace 生效 | ✅ `cargo test --workspace --lib` 全绿（1243 计：1089+93+61，spec 估算 ≈1260 与实测差异 = pylon-core 修复前计数口径）；3 子锁删除；unification 前后一致；clippy 零新增；fmt --all 单步 ✅；⚠️ release bundle 验证待 PR |
| 16 | CI 失败证据包 | ✅ `if: failure()` 步落地；⚠️ artifact 实际产出待 PR 人为失败验证 |
| 17 | mutants 手动触发 | ✅ workflow_dispatch 工作流落地；⚠️ 运行验证待 PR |
| 18 | dependabot checks | ✅ 配置合入；⚠️ checks 运行待 PR |
| 19 | temp 生存期 + 时钟注入 | ✅ TempPath Drop 清理 + 回归测试；时钟降级为编写约定（查证：26 处散布），已记录 |

**计数口径说明**：spec 估算「src-tauri 内嵌 1103 / 全 workspace ≈1260」为 3aa2e5e4 时点估值；实测基线（本分支起点）= pylon lib 1089 passed + 4 ignored、pylon-core 91+1 失败（修复后 93）、foundations 61、pet-core growth 68（`--tests` 目标）。本期新增净 +6（pylon 侧 harness/快照/幂等/封闭化各 1-2、bin 侧 11 个在 bin target）。

## 测试处置

- **新增**：bin 旗标/场景单测 11；harness 冒烟 + temp 清理 2；`report_from_parts` 封闭判定 + 真实差照报 2（净 +1）；build_app_state 快照 1；install_process_registrations 幂等 1。
- **修改（封闭化/换装配，断言语义不变）**：`unavailable_shell_path_is_not_reported_as_a_mismatch`（环境依赖→注入）；约 60 个 fake agent 构造点脚本→旗标；`codex_wrapper…argv` 断言的「解释器参数」形态随 bin 化更新为「场景旗标在 argv」；`checked_in_json_rpc_example` 的示例实现 python→node。
- **删除**：无删测试（仅迁移形态）。

## 证据

- 提交：`aad08de3`(P0) `fac65656`(P0锁) `78b433c2`(P1) `3ede5d60`(P3a) `c4383db3`(P2) `84c12a39`(P3b) `9bacfc70`(P6/P7) `57883362`(P1补漏)
- 门禁实测：`cargo test --workspace --lib --features test-agent` → 1089/93/61 全绿（含无 Python PATH 复验）；`cargo test --bin pylon-fake-agent` → 11 绿；golden `--check` PASS；`check:acp-shadow` ok；`check:ipc` 绿 + 负向判红；clippy 基线 4 crate 零新增；`cargo fmt --all --check` 绿；vitest 570/3789 绿（P4 回退后原样）
- 计时：vitest 基线 129s（setup 621.7s+environment 648.2s 占 ~90%）；rust 热增量 9s

## 与 spec 的偏差

1. **P5 未落地**：门面地基（harness 三路证据、TempPath、安装/装配入口）已就绪，但 4 文件 ~3000 行的物理迁移 + `pub` 门面（≈36 API）未完成。p1_wire 的 spec 回退条款继续有效。**遗留**：迁 `tests/integration.rs` 单 target 时按 spec P5 节执行。
2. **P4 未落地**：projects 三分层 + setup 拆分已实现过一版（基线与拆分后均实测：transform 149→268s 因各项目插件管线独立而翻倍；solid 桥接测试在并发下超时/互踩，单跑全过）。深度 perf 调优（optimizeDeps/worker 共享/超时预算）超出本期预算，按「不绕过门禁」原则整体回退，发现与名单（39 个 jsdom .test.ts 清单生成方式）记录在案。
3. **`--provider` 旗标未实现**：spec 旗标表列了它，实际 golden wrapper 场景的 provider 是**客户端身份**（AgentDef.provider 影响请求侧 clientCapabilities），bin 无需感知——保真由 AgentDef 注入达成，基线逐字节一致已证。
4. **`--id-mode` 简化为 `--permission-id <json>`**：JSON 值直接表达 number/string 形态，无需二选一旗标。
5. **`--advertise-models` 语义**：接受完整 session/load 响应体 JSON（含 sessionId/availableModels/currentModelId/configOptions），比 spec 表述的「availableModels 宣告」更宽，覆盖 revive 场景全部字段。
6. **pylon-core 环境依赖测试修复**：spec 未预见（P0 把它带进 CI 前它在本机也不绿）。
7. **check:rust 顺序**：spec 门禁顺序为「lib 测试→bin 构建→集成」；实际改为「bin 构建→lib 测试→集成」——P1 后 lib 内的集成形态测试也需要 bin，bin 前置对两阶段都成立。
8. **CI 解 skip 提前到 P1**（spec 安排在 P2/P5）：集成形态测试自 P1 起即无 Python 依赖，skip 名单没有存在理由。

## 未解问题

1. P4/P5 落地（见偏差 1/2）；P4 需要解决 projects 下 transform 管线独立导致的 solid 桥接测试延迟问题。
2. check:ipc 豁免清单中 **Prism 历史面 39 命令**前端零静态消费——后续要么接前端、要么后端下线（已注明在清单）。
3. CI 侧验证项（验收 3/14/16/17/18 的 ⚠️ 部分）待分支可推远端后由 PR run 判定。
4. release 构建在 rust-lld 下的 bundle 验证（P6 预案：异常则 release 工作流环境变量回退 MSVC link.exe）。

## 稳定性观测

**P4 追加诊断（同日）**：环境守卫式 setup 拆分（node 跳过 DOM 层，单项目架构不变）实测会以 ~50% 概率触发 `issue55.rowSetPurity.solid.test.tsx` 切片确定性断言非确定（原版 setup 3/3 绿；守卫版 4 跑 2 挂；单跑恒过）——setup 内动态 import 的初始化时序影响 solid token 切片的可复现性。结论：P4 的 setup/环境拆分必须以 project 隔离语义承载（每个 jsdom 文件独立进程+确定初始化序），单项目内的任何部分拆分都会引入此类非确定；与 projects 版并发超时问题同根，均指向「transform 管线与初始化时序」是 P4 的真正成本中心。


最终门禁复验曾出现 1 次 pylon-core 单测失败（92/1），随后 **5 次连续全量 workspace 复跑全绿**、pylon-core 单独 2 次复跑全绿——判定为并发重载下的偶发 flake（pylon-core 含 powershell/ping 真实进程夹具 managed_probe_cleanup_kills_descendant_processes，对负载时序敏感；该夹具系既有代码，非本期引入）。

## 并行交集

本次碰过的共享文件（其他贡献者避让）：`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`package.json`、`.github/workflows/ci.yml`、`scripts/check-clippy-baseline.mjs`、`src-tauri/src/lib.rs`、`src-tauri/src/test_utils.rs`、`src-tauri/src/dispatcher/mod.rs`（仅 stub 行）、`src-tauri/src/session/mod.rs`/`session/prompt.rs`（仅测试夹具段）、`src-tauri/src/acp/engine.rs`（仅 stub 行）、`docs/说明书/` 两处命令表述。其他 agent 的未提交内容一概未动。
