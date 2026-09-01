# Pylon 本机 ACP Agent 运行时探测施工书

> 状态：首片完成（Slice A/B/C 完成；真实运行时验收后置）
> 对应问题：[P3 · 本机 ACP Agent 运行时探测](Pylon-问题台账.md#p3)
> 范围：共享 Agent Catalog、pylon-core 探测器、Tauri 设置入口和隔离 ACP 验证

## 1. 施工目标

把本机 Agent 的“发现”“可启动”“ACP 握手完成”拆成可追溯的三段证据，降低仅凭命令名或配置文件产生的误报；失败必须保留阶段、可重试性和脱敏诊断。

## 2. 现状证据地图

| 阶段 | 生产入口 | 当前证据 |
| --- | --- | --- |
| 发现 | `shared/agent-catalog.json` → `pylon-core::agent_detection::find_rule` | 受控 PATH/平台目录、有限配置目录和 catalog invocation；候选带 `path`/`known-path`/`config-fields` 证据 |
| 可启动 | `pylon-core::agent_detection::version_probe` | 对候选执行 `--version`，有独立预算、输出上限、超时诊断和 Windows Job Object 清理 |
| ACP 握手 | `test_agent_candidate` / `test_agent_connection` → `AcpClient::connect_with_generation` | 15 秒总超时；spawn、initialize、capability 阶段错误结构化；成功后立即终止隔离进程 |

设置页通过 `agentClient.detectAgentRuntimes` 调用发现，候选导入前由 `AgentRuntimePanel` 调用 `test_agent_candidate`；`provisionAgentTransaction` 只有验证、持久化、刷新和激活全部完成才报告 ready。

## 3. 本轮调查结论

- 发现报告已经把 `identityConfidence` 与 `protocolAvailability` 分开；发现阶段不会伪造 ACP 已验证状态。
- 版本探针失败仍可保留候选（带 warning），由隔离 ACP 验证决定是否可导入；这保证“发现证据”和“运行证据”不混为一谈，但目前还没有独立的 `startability` 字段。
- Windows 清理回归曾因 `OpenProcess` 误把已退出进程对象判为存活而失败；生产 Job Object 清理实际生效。本轮将断言改为 `GetExitCodeProcess`，仅 `STILL_ACTIVE` 判定为存活。

## 4. 实施切片

### Slice A：探测/启动/握手证据基线（已完成）

- 修正 Windows 子孙进程清理测试的错误存活判定，避免误报阻塞后续探测工作。
- 复核共享 catalog、受控搜索边界、版本探针预算和隔离 ACP 验证入口。
- 保留字段值脱敏、候选数量上限和总时间预算。

### Slice B：三段状态模型

- 为候选增加明确的 `startability`（`not_tested` / `verified` / `failed`），避免 UI 只能从 warning 推断。
- 定义稳定状态转换：候选出现即 `discovered`；version probe 成功进入 `startability=verified`，spawn/等待/超时失败进入 `startability=failed`；ACP 隔离验证另行把 `protocolAvailability` 置为 `verified` 或 `failed`，不会覆盖启动证据。
- 导入门禁继续由隔离 ACP 验证结果控制：握手成功可直接导入；握手失败时仅高/精确身份置信候选允许显式“未验证导入”；发现或启动失败本身不伪造握手成功。

### Slice B（已完成）

- Rust `AgentRuntimeCandidate` 和 `pylon-detect --json` 已输出 `startability`；版本探针的 spawn、等待、非零退出、空输出及超时均明确为 `failed`，预算耗尽为 `not_tested`。
- 前端 DTO 归一化兼容旧 payload（缺字段按 `not_tested`），设置页同时展示身份、启动和 ACP 三段状态。
- 保持现有 `test_agent_candidate` 隔离语义，不启动或替换当前 active runtime。

### Slice C：观察与回归

- 为三段状态补齐更细的 DTO/CLI 错误契约和设置页回归快照：前端保留 capability 阶段、retryable、IO 类型及脱敏远端摘要，typed client 在边界归一化异常 payload。
- 覆盖 PATH、已知目录、launcher、版本超时、spawn 失败、initialize 失败和成功握手；诊断不得泄露配置值或凭据。

### Slice C（已完成）

- `candidateValidation` DTO 已覆盖 preflight/spawn/initialize/capability/timeout 五阶段，并保留 `retryable`、`ioKind`、`remoteCode` 和 `remoteDataSummary`。
- typed client 对 `test_agent_connection` / `test_agent_candidate` 统一归一化结果；设置页显示能力协商阶段，回归测试覆盖脱敏远端摘要。

## 5. 兼容性、性能与回滚

- 不改 ACP wire 协议、Agent Catalog schema 或 active runtime 生命周期；状态扩展只在探测/验证 DTO 边界进行。
- 发现总预算默认 8 秒，版本探针默认 2 秒并发上限 4；握手验证保持 15 秒总超时。
- 若状态模型引入回归，可回退到现有 `identityConfidence` + `protocolAvailability` DTO，保留本轮测试断言修正。

## 6. 验收标准

- 每个候选都能指出发现证据；可启动和 ACP 握手不得由同一个字段伪造。
- 版本探针、spawn、initialize、capability 失败均有阶段和可重试性；子进程及其子孙在超时/失败后可回收。
- 设置页、CLI 和导入事务对三段状态使用同一口径；全量前端测试、pylon-core 测试和架构门禁通过。
