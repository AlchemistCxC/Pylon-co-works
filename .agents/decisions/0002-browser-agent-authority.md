# ADR-0002：Agent 浏览器能力的 Rust 侧策略权威与持久化契约

状态：已验证（issue #82 实现落地；Windows 实机验收清单待人工执行，见开发记录）

## 问题与约束

issue #82 把原生浏览器 Sheet 暴露为 ACP agent 的工具面。需要决定：

1. 授权档位（off/readonly/full）、域名黑名单、广告过滤开关的**权威存放在哪一侧**——
   前端（localStorage/插件设置）还是 Rust；
2. agent 操作审计落在哪个存储面；
3. `BrowserManager`（浏览器所有权）与 `browser_agent`（策略决策）的依赖方向。

约束：MCP 桥与 `pylon_cli` 工具字典两条 agent 通道都必须经过同一策略，不能存在
前端可绕过的路径；持久化契约一旦落盘即成为 wire 契约，需向后兼容。

## 备选与决定

- **档位/黑名单/过滤设置**：前端 store（否——agent 经桥直调 Rust 命令，前端策略可被
  绕过且时序上先于会话注入）、`Workspace` 实体字段（否——档位是浏览器全局能力而非
  工作区业务数据，工作区仅做覆盖）→ **决定**：Rust 侧 `pylon-browser-agent.json`
  （config_root，`write_config_atomically` 原子写，登记 portable 迁移清单），
  `BrowserAgentHub` 为唯一权威；前端面板与 sessionCreation 注入均经命令读写。
  工作区覆盖以 `workspace_modes` 映射内置于同一文件。
- **审计**：独立 SQLite 表（否——需动 SCHEMA_MANIFEST/迁移链，收益不成比例）、
  canonical_events（否——owner_key/sequence 语义属于会话事实流）→ **决定**：复用
  `user_data` 表，新增 `UserDataKey::BrowserAgentOps`（versioned envelope v1 +
  revision 乐观并发，ring buffer 50 条）；持久化尽力而为，不阻断工具调用。
- **依赖方向**：`browser_agent` 依赖 `browser` 的类型与命令面（单向）；导航导致的
  per-tab 状态失效（ref 注册表）经 `BrowserManager::register_page_load_hook` 回调
  解耦，`browser.rs` 不 import `hub`。

## 后果

- 桥进程与 `pylon_cli` 的所有工具调用都落到 `browser_agent_cmds` 的
  `authorize → ensure_write_claim → 执行 → finish(审计)` 单点链路；设置文件在
  Rust 侧载入后即权威，前端只是编辑器。
- `browser-agent-ops` 行成为新的持久化契约（envelope v1：`ops[]` 含
  atMs/sessionKey/tool/summary/outcome/driver）；后续新增字段需 bump envelope
  version 并保持 validate 兼容。
- `pylon-browser-agent.json` schema v1（defaultMode/workspaceModes/
  domainBlocklist/adFilterEnabled）同上；损坏/缺字段静默回落默认（readonly）。

## 证据

- `src-tauri/src/browser_agent/{hub,settings,audit,policy,claim}.rs`、
  `src-tauri/src/browser_agent_cmds.rs`（finish 收口）；
- `src-tauri/src/session/user_data.rs`（BrowserAgentOps 校验器）；
- `src-tauri/src/paths.rs`（browser_agent_settings_path + 迁移清单）；
- 测试：browser_agent 40 例 + 全库 `cargo test --lib` 绿（2026-09-15）。
