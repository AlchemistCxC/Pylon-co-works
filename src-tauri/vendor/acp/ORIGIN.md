# codeg 迁入源码来源登记（ORIGIN）

> 本目录（`src-tauri/vendor/acp/`）只存放从 codeg 迁入的**源码副本**，用于溯源、许可证履约与逐文件比对。
> 它**不是编译目标**：Cargo 不编译 `vendor/`，Pylon 的行为改动一律落在 `src-tauri/src/acp/` 的 adapter 中。
> 任何进入本目录的文件都必须在本文件登记，并由 `node scripts/check-vendor-provenance.mjs` 校验（A0 门禁）。

## 1. 来源锁定

| 项 | 值 |
| --- | --- |
| 项目 | codeg（本地只读调研副本） |
| 锁定 commit | `b2eec98ce8d082ad48803918dd9a21ab08d1d3d4` |
| 本地副本根 | `F:\Hermes\profiles\riccati\workspace\pylon-survey-2026-09\codeg-src` |
| 许可证 | Apache License 2.0 |
| 许可证文本 | `LICENSES/Apache-2.0.txt` |
| 版权声明 | 根 `NOTICE` |
| Pylon 许可证 | MIT（根 `LICENSE`） |
| 校验脚本 | `scripts/check-vendor-provenance.mjs` |

读取纪律：只读本片点名的符号区间；不得通读 `acp/connection.rs`（21,689 行）、`acp/manager.rs`（8,896 行）、`acp/registry.rs`；不得读取 codeg 的 DB 实体、`web/`、React/Next 前端。

## 2. 协议栈决策矩阵（A0）

| 候选 | 版本 | 依赖的 schema | 结论 |
| --- | --- | --- | --- |
| 官方 `agent-client-protocol` | `2.1.0`（pin schema `1.7.0`） | `agent-client-protocol-schema 1.7.0` | **采用**（D1=①） |
| codeg `sacp` / `sacp-tokio` | `11.0.0`（crates.io 最新，2026-03-16） | `agent-client-protocol-schema ^0.11.0` | **不采用** |
| Pylon 现状（手写 ACP） | — | `agent-client-protocol-schema 1.4` | 升级到 1.7（5 处引用：`acp/error.rs`、`acp/protocol.rs`、`mcp.rs`、`permission.rs`×2） |

不采用 sacp 的依据：`sacp 11.0.0` 依赖 `agent-client-protocol-schema ^0.11.0`，与 Pylon 现有 1.4.0 及官方 2.1.0 所 pin 的 1.7.0 不同代；codeg 的 `vendor/sacp-tokio` 是实质 fork（`vendor/sacp-tokio/src/acp_agent.rs` 567→1405 行，新增 `kill_tree` 与 `with_current_dir/on_spawn/on_exit`），不随 crates.io 维护。

配套约束：

- **不可混用** `agent-client-protocol-tokio`（最新 0.11.1 依赖 `agent-client-protocol ^0.11.1`）；Pylon 自行用 `tokio_util::compat` 桥接 `ByteStreams`。
- A7-M 使用 `agent-client-protocol-rmcp 3.1.0`（依赖 `agent-client-protocol ^2.1.0` + `rmcp ^2.1.0`）；`rmcp` 最新为 3.2.0，本工程固定 2.1.x，不得引入第二个 rmcp major。
- schema `1.7.0`：`session_resume` 为标准方法；`session_fork` 在 `unstable_session_fork` feature 之后；`session_set_model` 仍是 Hermes 私有扩展，不得当作标准方法。

## 3. 迁入文件登记（机器可读）

`scripts/check-vendor-provenance.mjs` 解析下面这个代码块；新增迁入文件必须同时在此登记，否则门禁失败。

```json provenance
{
  "source": {
    "project": "codeg",
    "commit": "b2eec98ce8d082ad48803918dd9a21ab08d1d3d4",
    "license": "Apache-2.0",
    "licenseFile": "LICENSES/Apache-2.0.txt",
    "noticeFile": "NOTICE"
  },
  "files": [
    {
      "vendoredPath": "src-tauri/vendor/acp/acp_transcript.rs",
      "sourcePath": "src-tauri/src/acp_transcript.rs",
      "sha256": "bebcae80beb8ccb0fcd3984cd3e347d77a5c7751615bc37dfaa950d1622ac002",
      "modifications": "逐字副本，未修改。Pylon 侧（A3）只取纯算法 parse_transcript / read_chain_in / continuation_ancestors_in / compact_batch，且只作取证导出，不建第二 durable store（D2=①）。",
      "consumer": "A3 → src-tauri/src/acp/transcript.rs",
      "unmigratedDeps": [
        "crate::paths::codeg_acp_transcripts_root()",
        "crate::models::message::{MessageTurn, TurnRole, ContentBlock}",
        "crate::parsers::acp_native::project_turns（测试用）",
        "tokio::sync::oneshot + std::sync::mpsc 写入线程（文件 durable 写入路径，不迁）"
      ]
    }
  ]
}
```

## 4. 依赖树与 Pylon 替代物

逐文件登记时，`use crate::` 依赖必须映射到 Pylon 替代物；映射表：

| codeg 依赖 | Pylon 替代物 |
| --- | --- |
| `models::agent::AgentType` | Pylon agent id（`agent_config::AgentDef.name` / catalog `id`） |
| `sacp::Error` | `AcpError`（稳定 `ErrorCode`） |
| `parsers::expand_home_prefix` | `paths.rs` |
| `crate::paths::codeg_acp_transcripts_root()` | `paths.rs` 下 Pylon 取证导出目录（A3） |
| `crate::models::message::*` | canonical `CanonicalEventRow` / `WorkbenchDocument` 投影 DTO |

## 5. 未迁入面（D8 排除，登记备查）

`AgentDistribution` / `binary_cache` 的下载·解压·`sha256` 校验·缓存写入、`preflight` 的安装动作、`antigravity_login` 登录流、`remote_registry` / `custom_registry` 持久化、`npm_install_attempts` / `prewarm_uvx_agent` 安装动作，以及 codeg 的 `AppState`、数据库实体/迁移、`web/` 前端与 React context。

## 6. 变更流程

### A-DETECT preflight 版本解析（生产代码摘取）

### A-DETECT 进程版本输出回退

- 来源：同一锁定 commit 的 `src-tauri/src/commands/acp.rs::probe_cli_version_token`（stdout 解析失败后尝试 stderr）。目标为 `pylon-core/src/agent_detection.rs::version_probe`；保留 Pylon 的有界输出、进程树回收、预算、catalog 参数和缓存，删除“仅 stdout 为空才回退”的偏离路径。
- 验证：`version_probe_uses_catalog_arguments_and_standard_default` 改为真实进程夹具，stdout 输出非版本提示、stderr 输出参数决定的版本，另断言非法参数导致非零退出；修复前失败、修复后通过。

### A4 filesystem path containment

- 来源：锁定 commit `b2eec98ce8d082ad48803918dd9a21ab08d1d3d4`，`src-tauri/src/acp/file_system_runtime.rs::ensure_path_allowed` 与 `canonical_target_path`。
- 目标：`src-tauri/src/acp/fs_policy.rs::ensure_path_allowed`；保留空 roots unrestricted、canonical existing target、canonical parent for new writes、whole-component `starts_with` containment，错误映射为 Pylon 字符串边界。
- 未迁入：codeg AppState、AgentType root registry、fs IO executor、安装/持久化；未来 responder 只消费该策略函数。
- 证据：`path_policy_uses_component_containment_and_parent_for_new_writes`。

### A4 filesystem access policy constructors

- 来源：锁定 commit `b2eec98ce8d082ad48803918dd9a21ab08d1d3d4`，
  `src-tauri/src/acp/file_system_runtime.rs::FsAccessPolicy::{strict,unrestricted,confines_reads}`。
- 目标：`src-tauri/src/acp/fs_policy.rs::FsAccessPolicy`；`strict` canonicalize
  workspace root 并同时约束读写，`unrestricted` 使用空 roots 的上游语义，
  `confines_reads` 仅反映读方向是否有根目录门控。
- 未迁入：codeg agent data/temp/extra-root 计算、AppState、文件 IO executor 和
  ACP responder；这些必须在正式 Pylon runtime 接缝确定后再迁入。
- 证据：`strict_policy_uses_one_canonical_workspace_root_for_reads_and_writes`、
  `unrestricted_policy_has_no_read_or_write_roots`。

### A4 terminal policy/runtime adapter

- 2026-09-09 纠偏：`437fc864` 新增的 `TerminalLifecycle` 四态枚举并非上游搬迁，且没有生产消费者，现已删除。上游实际为 `TerminalCompletion::{Running, Exited(TerminalExitStatus)}` + watch（`send_replace` 保留无订阅者时的终态），kill 使用 Notify 请求唯一进程 owner，release 先移除 registry 项再调用 kill。不得把被删除的枚举及自证测试视为生命周期验收证据。`ManagedChild` 已被 `plugin_process` 复用，并非 ACP agent 专属，前述“不能复用”的口头判断撤回。
- `next_wait_retry_backoff` 来源为同文件 owner loop 的 `(backoff * 2).min(WAIT_RETRY_MAX_BACKOFF)`，Pylon 提取时增加乘法溢出保护；当前只有测试消费者，不代表 wait 重试已接入运行时。

- 来源：锁定 commit `b2eec98ce8d082ad48803918dd9a21ab08d1d3d4`，`src-tauri/src/acp/terminal_runtime.rs` 的 `enforce_output_limit`、`decode_available_utf8`、`default_platform_shell`、`shell_wrapped_command`、`map_exit_status` 及其限值常量。
- 目标：`src-tauri/src/acp/terminal_policy.rs`。迁入纯输出预算、增量 UTF-8 解码、shell family/wrapper 参数、平台默认 shell 和 typed `TerminalExitStatus`；Pylon 保留既有 `ManagedChild` 作为进程所有者，未复制 codeg `TerminalRuntime`/AppState/协议 handler。
- 适配：`TerminalExitStatus` 字段为 `exitCode`/`signal`；核验 schema 1.7 的 `schema::v1::TerminalExitStatus` 已存在，后续 responder 应直接映射到官方类型，不再新增第二个 wire DTO。
- 证据：terminal policy 定向测试覆盖 UTF-8 partial chunk、字节截断、shell 参数、默认 shell、DTO 序列化；未将纯策略测试误标为完整 terminal runtime 验收。

### A4 terminal registry seam

- 来源：锁定 commit `b2eec98ce8d082ad48803918dd9a21ab08d1d3d4`，
  `src-tauri/src/acp/terminal_runtime.rs::TerminalInstance` 的 completion、snapshot、
  session ownership、release 顺序与 bounded output 语义。
- 目标：`src-tauri/src/acp/terminal_runtime.rs`；registry 每个实例持有一个现有
  `ManagedChild`，用 `watch::send_replace` 保留短命进程终态，所有操作先校验
  session owner；不复制 codeg 的 AppState 或第二进程 owner。
- 未迁入：subprocess spawn、stdout/stderr reader task、kill escalation、ACP
  responder；本片是 registry seam，不是 A4 整片完成。
- 证据：`registry_confines_operations_to_session_owner`、
  `completion_watch_retains_exit_for_late_waiter`；提交 `44b47f84`。
- `e3d22c29` 补齐 codeg `drain_readers` 语义：子进程已退出后先等待 reader
  任务最多 `READER_DRAIN_GRACE`，再发布 completion；超时只 abort reader，不丢弃
  已收到的 snapshot 输出。当前仍未接入 JSON-RPC responder。
- `b1828c3a` 补齐 codeg owner-task kill 语义：调用方只通知 owner，owner 在唯一
  `ManagedChild` 上执行 `kill_and_wait`，再 drain reader、发布已结束 completion；
  kill 报告有界，不在 async mutex 内直接阻塞。
- `8637f68c` 接入 ACP dispatcher 的 terminal request responder：runtime registry
  按 session owner 路由 create/output/wait/kill/release；默认
  `AgentSelfHosted` 仍 fail-closed，未授权请求返回 JSON-RPC `-32601`。当前
  `HostStrict/HostUnrestricted` 的配置入口尚未接入 AgentDef schema。
- `ef1613d5` 以既有 per-agent `env`（`PYLON_ACP_HOST_TOOLS`）作为配置入口，激活
  runtime 时解析并注入 HostToolsPolicy；非法值记录诊断并回到
  `AgentSelfHosted`，不改变默认拒绝语义。

### A4 question outcome policy

- 来源：锁定 commit `b2eec98ce8d082ad48803918dd9a21ab08d1d3d4`，
  `src-tauri/src/acp/question.rs::{QuestionAnswer,QuestionOutcome,build_outcome}`。
- 目标：`src-tauri/src/acp/question_policy.rs`；保留 typed answer/outcome、declined
  语义、单选/多选上限、空标签过滤与边遍历边截断。Pylon 不复制 codeg 的
  `SessionState`/one-shot listener/UI 依赖。
- 证据：`builds_bounded_outcome_and_preserves_decline` 及既有 parse/validate 测试。

- 来源：锁定 commit `b2eec98ce8d082ad48803918dd9a21ab08d1d3d4`，`src-tauri/src/acp/preflight.rs` 的 `parse_node_version`；Apache-2.0，沿用根 NOTICE 与许可证。
- 目标：`src-tauri/pylon-core/src/agent_preflight.rs`，由 catalog Node/uv minimum 检查消费；解析函数按上游迁入，替换将非法分量转换为零的手写比较器。
- Pylon 接缝：catalog `params.min` 和 `PreflightInputs`；缺失/非法版本不能证明满足要求。未迁上游 registry、AppState、探测缓存和安装动作。
- 证据：`invalid_or_missing_versions_cannot_pass_a_requirement`、`upstream_parser_accepts_banner_whitespace_and_patch_suffixes`。Node/uv 的完整状态分级、采集与 fix action 仍待整片收敛，不以此宣称 preflight 完成。

1. 新增迁入文件：复制到 `src-tauri/vendor/acp/` → 计算 `sha256` → 在本文件 §3 追加登记（含 `sourcePath`、`modifications`、`consumer`、`unmigratedDeps`）→ 跑 `node scripts/check-vendor-provenance.mjs`。
2. 修改已迁入副本：**不要**直接改 `vendor/` 里的文件；在 Pylon adapter 中改写，并在本文件 `modifications` 字段记录改动摘要。若确需改动副本本身（例如去掉不可编译的前端依赖），必须在 `modifications` 写明并更新 `sha256`。
3. 新增 crate 落点、依赖方向与职责边界按施工书 §0 纪律同步登记到 `Docs/Pylon-问题台账.md` P60 条目。
