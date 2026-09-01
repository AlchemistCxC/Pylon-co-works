# Pylon MCP、Skill、插件设置管理施工书

> 状态：首片完成（Slice A/B/C 完成；真实配置验收后置）
> 对应问题：[P5 · MCP、Skill、插件设置管理](Pylon-问题台账.md#p5)
> 范围：Workspace 能力选择、Agent 级 MCP 配置、API 1.0 插件包与插件设置命名空间

## 1. 施工目标

把 MCP、Skill、Hook/插件能力从逗号文本和分散入口收敛为可枚举、可校验、可观察的设置模型；保持工作区选择与新会话快照语义，不把插件设置或 MCP 凭据混入会话事实、日志或渲染状态。

## 2. 现状证据地图

| 能力 | schema / 事实源 | 存储与入口 | 当前边界 |
| --- | --- | --- | --- |
| MCP server | `src-tauri/src/mcp.rs::McpServerConfig`；stdio/http/sse/streamable-http；最多 32 个，参数/env/header 各有上限 | Agent 级 `get_mcp_servers` / `set_mcp_servers`；后端原子写本地 JSON，session/new、load、prompt 前序列化 | `env`/header/ OAuth client secret 属本地配置；不进日志，但当前未提供密钥引用或权限审批 UI |
| Workspace MCP 选择 | `Workspace.mcpServerIds`；仅保存 server id/name 字符串 | `CwdSettingsPanel` 读取 Agent 暴露列表后勾选，`workspace_update` 持久化；新会话 preflight 解析并生成快照 | Agent 列表变化后旧 id 可悬挂；UI 只显示 transport/name，未显示 unavailable/校验错误 |
| Skill | `Workspace.skills`、`Session.skills` 字符串数组 | Workspace 设置逗号分隔输入；创建会话时复制为不可变快照 | 没有 Skill registry/schema、来源/版本/启停状态；未知 id 不校验 |
| Hook 插件 | `Workspace.hookPluginIds`、session `workspaceHookPluginIds` 快照 | Workspace 设置逗号分隔输入；运行时 `hookPipeline` 按启用插件 id 过滤 | 仅按字符串引用，未与 Plugin Registry 做可用性诊断；权限由插件 scope/生命周期负责 |
| API 1.0 插件 | `pylon-plugin.json` schema 1：id/name/version/api/kind/web；依赖、冲突、激活事件、热更新 | `PackageInstallationService` + Tauri `plugin_package_*` 命令；包目录安装、启停、更新、卸载、回滚 | manifest 明确拒绝 `trust/capabilities/contributes/signature/entry` 旧字段；未提供 MCP/Skill 专属贡献 schema |
| 插件私有设置 | `PluginSettingsPageContribution`；`PluginSettingsStore` 每插件命名空间 | localStorage `pylon-plugin-settings-v1`；设置页按 `pluginId` 订阅，只能通过 `setValue/removeValue` 写入 | key 与 JSON 值校验、每命名空间 64 KiB；卸载默认不清理，`purgeData` 由包存储层显式决定 |

## 3. 调查结论

- MCP 配置是 Agent 级事实，Workspace 只保存选择引用；两者不可合并成一份“工作区 MCP 配置”，否则会破坏 session 快照和 Agent 切换边界。
- MCP 的校验/序列化和落盘已经有明确 seam（写序锁、临时文件 rename、损坏文件静默丢弃）；后续 UI 应复用 typed client，不绕过后端校验。
- Skill 当前只是透传 id，不能在设置页凭名称推断安装状态；需要先定义 Skill catalog/来源，再提供结构化选择器。未知 Skill 应保留并标记 unavailable，不能静默删除历史配置。
- Hook 插件引用必须以 Plugin Registry 为可用性事实源；停用/清理失败时应显示诊断，不能让 Workspace 文本直接启动插件资源。
- 插件包与插件设置已有生命周期和 scope 隔离：安装/启停走 `PackageInstallationService`，资源走 `PluginScope`，私有设置按 pluginId 隔离。新增 MCP/Skill 贡献前应扩展 manifest/registry，而不是让插件直接写 Workspace 或 Agent 配置。
- 当前设置页的逗号分隔输入是主要体验缺口；它可以作为兼容回退，但结构化编辑必须保持数组顺序、去重和未知项可见性。

## 4. 实施切片

### Slice A：统一能力 DTO 与可用性诊断

- 为 Workspace 能力选择定义 `CapabilityOption`（kind/id/label/source/enabled/available/diagnostic），分别适配 MCP、Skill、Hook plugin。
- 保留当前持久化字段；读取时将字符串引用映射为选项，未知项生成 unavailable 诊断而不丢失。
- 约束 MCP 选择只能来自当前 Agent 暴露 id/name；保存仍走 workspace update 和后端 MCP 校验。

### Slice A（已完成）

- 新增 `CapabilityOption` 与 `buildCapabilityOptions`，统一 MCP/Skill/Hook plugin 的来源、启用、可用性和诊断字段。
- `CwdSettingsPanel` 的 MCP 选择使用该 DTO；持久化但当前 Agent 已不再暴露的 id 保留为 unavailable，用户可取消选择，不会静默丢失。

### Slice B：结构化设置 UI

- 用可添加/删除的 tag/list 控件替代逗号文本；MCP 显示 transport、来源和不可用原因，Skill/Hook 显示 registry 状态。
- 保持“仅新会话生效”提示；保存前显示去重结果和悬挂引用，不自动改变已有 session 快照。

### Slice B（已完成）

- Skills、Hook 使用结构化标签预览和单项移除入口，保留旧逗号输入作为兼容编辑方式并显示已选数量。
- MCP 选择展示 transport、来源和 unavailable 诊断；悬挂引用仍可取消，不会被读取过程静默删除。

### Slice C：贡献与权限契约

- 评估 API 1.1 manifest 的 Skill/MCP contribution schema、版本/来源和用户授权边界；API 1.0 不接受未定义字段。
- 明确 MCP 凭据引用/secret store 方案，继续禁止日志、诊断和 renderer 读取明文值。
- 增加插件停用、卸载、scope 清理和 workspace 引用的回归矩阵。

### Slice C（已完成评审）

- API 1.0 manifest 已拒绝未定义的 `trust/capabilities/contributes/signature/entry` 字段；Skill/MCP 贡献保持在后续 API 版本评审，不向 1.0 偷渡 schema。
- MCP 明文 env/header 仅作为本地配置持久化，现有日志/诊断路径不读取；凭据引用/secret store 留作后续 API 1.1 议题。
- `PluginScope`、包启停/卸载清理和按 pluginId 隔离的 `PluginSettingsStore` 已有回归覆盖；本轮未发现越权或应删除的过时测试。

## 5. 兼容性、性能与回滚

- 不修改现有 `Workspace`、`Session`、MCP wire schema；先在读取/显示边界增加 DTO，旧数组和逗号文本均可迁移回退。
- 选项解析 O(n) 且不复制 MCP env/header 值；列表上限沿用后端 32 server 与插件命名空间 64 KiB 限制。
- 若结构化 UI 回归，可回退到兼容文本编辑器；未知引用和后端校验逻辑保留。

## 6. 验收标准

- MCP、Skill、Hook 选项均能显示来源、启用状态和 unavailable 原因；保存不丢未知历史引用。
- MCP 仍由 Agent 级配置提供，Workspace 只存选择；session 创建/恢复快照和 wire 序列化结果不变。
- 插件只能通过 scope-bound API 修改自身设置；停用/卸载不会越权修改其他插件或 Workspace，凭据不进入日志与诊断。
