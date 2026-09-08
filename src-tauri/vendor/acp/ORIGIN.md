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

- 来源：锁定 commit `b2eec98ce8d082ad48803918dd9a21ab08d1d3d4`，`src-tauri/src/acp/preflight.rs` 的 `parse_node_version`；Apache-2.0，沿用根 NOTICE 与许可证。
- 目标：`src-tauri/pylon-core/src/agent_preflight.rs`，由 catalog Node/uv minimum 检查消费；解析函数按上游迁入，替换将非法分量转换为零的手写比较器。
- Pylon 接缝：catalog `params.min` 和 `PreflightInputs`；缺失/非法版本不能证明满足要求。未迁上游 registry、AppState、探测缓存和安装动作。
- 证据：`invalid_or_missing_versions_cannot_pass_a_requirement`、`upstream_parser_accepts_banner_whitespace_and_patch_suffixes`。Node/uv 的完整状态分级、采集与 fix action 仍待整片收敛，不以此宣称 preflight 完成。

1. 新增迁入文件：复制到 `src-tauri/vendor/acp/` → 计算 `sha256` → 在本文件 §3 追加登记（含 `sourcePath`、`modifications`、`consumer`、`unmigratedDeps`）→ 跑 `node scripts/check-vendor-provenance.mjs`。
2. 修改已迁入副本：**不要**直接改 `vendor/` 里的文件；在 Pylon adapter 中改写，并在本文件 `modifications` 字段记录改动摘要。若确需改动副本本身（例如去掉不可编译的前端依赖），必须在 `modifications` 写明并更新 `sha256`。
3. 新增 crate 落点、依赖方向与职责边界按施工书 §0 纪律同步登记到 `Docs/Pylon-问题台账.md` P60 条目。
