# Pylon CLI 命令表

> 适用版本：Pylon 1.5.9（2026-09-06）  
> 单一真值：`shared/pylon-cli-manifest.json`（CLI 壳命令）+ 运行时 Command Registry（插件命令）

Pylon CLI 连接已经运行的桌面应用。CLI 壳不复制插件业务逻辑：固定控制命令进入对应控制端口，插件功能统一通过 `command exec <commandId>` 调用。

## 1. 通用语法

```powershell
pylon-cli [--json] [--timeout <ms>] <command> [positionals] [--key <value>] [--args <json>]
```

| 参数 | 含义 |
|:--|:--|
| `--json` | 输出稳定 JSON envelope |
| `--timeout <ms>` | 请求超时；长操作超时后进入取消路径 |
| `--args '{...}'` | 合并 JSON 对象参数；适合复杂/嵌套参数 |
| `help` / `--help` | 列出 CLI 壳命令和别名 |
| `--version` | 显示版本 |

所有变更操作返回 `operationId`；用 `operation inspect/logs/cancel` 查询或取消。

## 2. CLI 壳命令（58 个）

| 命令 | 主要参数 | 说明 |
|:--|:--|:--|
| `plugin list` | `--plugin-id` | 列出活动插件及开关状态 |
| `plugin inspect <pluginId>` | `--instance` | 检查活动实例 |
| `plugin enable/disable <pluginId>` | — | 启用或停用插件 |
| `plugin reload <pluginId>` | `--mode auto\|parallel\|exclusive\|soft-remount\|restart-required` | Shadow reload |
| `package list` | — | 列出已安装插件包 |
| `package inspect <sourcePath>` | — | 预检插件目录及 manifest |
| `package install <sourcePath>` | — | 安装新包或 Shadow Update 已安装包 |
| `package enable <pluginId>` | — | 持久启用已安装包并激活运行时 |
| `package disable <pluginId>` | — | 停用运行时并持久关闭已安装包 |
| `package reload <pluginId>` | — | 重载已启用的安装包 |
| `package versions <pluginId>` | — | 列出不可变包版本 |
| `package rollback <pluginId>` | `--package-instance-id` | 回滚 active package pointer；要求先执行 `package disable` |
| `package uninstall <pluginId>` | `--purge-data true` | 卸载包；默认保留插件数据 |
| `hook list` | `--name`、`--plugin` | 列出 Hook |
| `hook trace` | `--hook`、`--session`、`--limit` | 查询 Hook trace |
| `process list` | `--plugin`、`--runtime-instance-id` | 列出插件进程 |
| `process logs <processId>` | `--stdout/--stderr`、`--limit` | 查询进程日志 |
| `process terminate <processId>` | — | 终止插件进程 |
| `workspace list` | — | 列出打开的 Sheet |
| `workspace open <type>` | `--title`、`--agent-id`、`--state` | 打开 Sheet |
| `workspace close <workspaceId>` | — | 关闭 Sheet |
| `agent list` | — | 返回已配置 Agent、ACP 探测候选及 Agent Catalog |
| `agent import <candidateId>` | `--agent-id` | 验证并导入探测候选 |
| `agent set-default <agentId>` | — | 设置默认 Agent |
| `session list` | — | 列出持久化 Session |
| `session create` | `--agent-id`、`--cwd`、`--workspace-id`、`--title` | 创建本地及 ACP Session |
| `session send <sessionId> <content>` | 或 `--content` | 经 `message.user.beforeSend` Hook 发送 |
| `session close <sessionId>` | — | 关闭 ACP Session |
| `session cancel <sessionId>` | — | 调用 ACP `cancel_prompt` |
| `session inspect <sessionId>` | — | 单会话状态 + generating 标志 + ownerKey |
| `session messages <sessionId>` | `--after-seq`、`--limit` | journal 消息查询（增量分页，AI 驱动闭环） |
| `session config set <agentId> <sessionId> <key> <value>` | — | 会话级配置选项（模型/思考档位等） |
| `session export <agentId> <periId> <outputPath>` | `--format` | 会话 journal 导出 |
| `approval get` | — | 读取当前全局审批模式（bypass/auto/edit/default） |
| `approval set <mode>` | — | 设置全局审批模式（外部自动化总开关） |
| `interaction list` | — | 全部挂起权限请求快照（含应答所需 identity 与 options） |
| `interaction respond <requestId> <optionId>` | — | 应答权限请求（optionId 经合法性校验） |
| `workspace registry list` | — | 列出注册表工作区（Workspace 实体，非打开的 Sheet） |
| `workspace registry create <agentId> <name> <rootPath>` | — | 创建工作区实体 |
| `workspace registry update <workspaceId>` | `--name`、`--root-path` | 更新工作区名称/根路径 |
| `workspace registry delete <workspaceId>` | — | 删除工作区（Session 解绑，cwd 冻结保留） |
| `workspace registry search <query>` | `--max-results` | 按名称/路径搜索工作区 |
| `command list` | `--plugin`、`--executable true` | 动态列出全部插件命令 |
| `command inspect <commandId>` | — | 查看命令 owner、参数提示、权限和可执行性 |
| `command exec <commandId>` | `--args '{...}'` | 执行任意插件命令 |
| `registry list` | — | 列出 Workspace、Renderer、Service、Sidebar、File Workbench、右栏、呈现风格、设置页等贡献 |
| `event log` | `--limit` | 聚合 operation 与 Hook trace |
| `operation inspect/logs/cancel <operationId>` | — | 操作诊断与取消 |
| `skin schema` | — | Skin Schema 快捷入口 |
| `skin draft create/patch` | 见 `command inspect` | Skin Draft 快捷入口 |
| `skin preview/capture/commit/rollback` | 见 `command inspect` | Skin preview 闭环快捷入口 |

显式别名：`ps`、`logs`、`kill`、`compact`、`model`、`new`、`export`、`clear`、`mode`。第一段还支持无歧义前缀，例如 `sess list`。

## 3. 内置插件命令（64 个）

以下命令均已注册 `execute`，通过 `pylon-cli command exec <id> --args '{...}'` 调用。外置插件新增可执行命令后会自动出现在 `command list`，无需修改 CLI 壳。

### 3.1 会话快捷命令

| Command ID | 参数 | 行为 |
|:--|:--|:--|
| `model` | `sessionId`, `name` | 切换 Session 模型 |
| `mode` | `sessionId`, `mode` | 切换权限模式 |
| `compact` | `sessionId` | 经消息 Hook 发送 `/compact` |
| `new` | `agentId?`, `cwd?`, `workspaceId?`, `title?` | 创建 Session |
| `export` | `sessionId`, `outputPath`, `format?` | 导出持久化会话 |
| `clear` | `sessionId?` | 清空活动聊天视图 |

### 3.2 FileSheet 与 Git

| Command ID | 参数 |
|:--|:--|
| `file.entries.list` | `sessionId`, `path?` |
| `file.text.read` | `sessionId`, `path` |
| `file.text.write` | `sessionId`, `path`, `content`, `expectedBaseline?`, `force?` |
| `file.search` | `sessionId`, `query` |
| `git.status` | `sessionId` |
| `git.history` | `sessionId`, `limit?` |
| `git.diff` | `sessionId`, `path`, `staged?` |

文件路径永远相对 Session 绑定的 Workspace；仍受后端 traversal/outside 校验约束。

### 3.3 布局与 Sheet

`layout.inspect`、`layout.sidebar.set`、`layout.sidebar-width.set`、`layout.right-panel.set`、`layout.pet.set`、`layout.agent-sidebar.set`、`workspace.sheet.focus`、`workspace.sheet.pin.toggle`、`workspace.sheet.close-others`、`workspace.sheet.close-right`、`workspace.sheet.reopen`。

### 3.4 呈现风格

`presentation.list`、`presentation.inspect`、`presentation.apply`。

呈现风格和消息渲染器保持正交：`presentation.apply` 修改视觉/交互 token。消息渲染引擎/Suite 的选择由设置中的 Renderer Suite 选择器（呈现偏好）管理，当前没有对应的 CLI 命令。

### 3.5 插件设置、主题与配置

| Command ID | 参数 |
|:--|:--|
| `plugin-settings.pages` | — |
| `plugin-settings.get` | `pluginId`, `key?` |
| `plugin-settings.set` | `pluginId`, `key`, `value` |
| `plugin-settings.remove` | `pluginId`, `key` |
| `theme.inspect` | — |
| `theme.patch` | `zone`, `patch` |
| `theme.reset-zone` | `zone` |
| `theme.reset` | — |
| `config.export` | —；返回 JSON payload |
| `config.import.preflight` | `payload`；只预检，不写入 |

配置导入落盘仍保留在 GUI 确认流程；CLI 只提供预检，避免无人值守命令直接覆盖整套用户配置。

### 3.6 Skin（11 个）

`skin.schema`、`skin.inspect`、`skin.draft.create`、`skin.draft.patch`、`skin.validate`、`skin.preview`、`skin.preview.patch`、`skin.inspect-computed`、`skin.capture`、`skin.rollback`、`skin.commit`。

### 3.7 Browser Sheet（16 个）

Browser Sheet 的 Agent 控制面复用同一个 `pylon_cli` 工具和 Command Registry。桌面端命令
实际操作嵌入式 WebView2；浏览器开发预览会明确返回 `iframe-preview`，不把预览伪装成
桌面会话。

| Command ID | 参数 | 行为 |
|:--|:--|:--|
| `browser.ensure` | `url?` | 打开/聚焦 Browser Sheet，等待会话就绪（可选导航） |
| `browser.status` | — | 读取会话、活动标签和地址 |
| `browser.navigate` | `url` | 当前标签导航 |
| `browser.open-tab` | `url` | 新建并激活指定 URL 的内部标签 |
| `browser.new-tab` | — | 新建空白内部标签 |
| `browser.select-tab` / `browser.close-tab` | `tabId` | 切换或关闭标签 |
| `browser.back` / `browser.forward` / `browser.reload` | — | 导航历史控制 |
| `browser.snapshot` | — | 读取正文摘要和可见链接（不含 cookie/storage） |
| `browser.click` | `selector` 或 `text` | 点击页面元素 |
| `browser.type` | `text`、`selector?` | 写入输入控件 |
| `browser.press` | `key` | 派发键盘按键 |
| `browser.scroll` | `deltaX?`、`deltaY?` | 滚动页面 |
| `browser.zoom` | `zoomPercent` | 设置 Browser Sheet 缩放 |

`browser.click` 命中普通 HTTP(S) 链接时会直接返回 `openedTab: true` 并创建内部标签，
避免 Agent 的非信任 click 事件被浏览器弹窗策略吞掉。开发浏览器通过 Vite 的
真实网页代理提供同源 iframe 桥接；无法代理或被页面策略阻断时会返回 `preview_only`。
桌面 WebView2 仍是完整操作面。

## 4. 常用示例

```powershell
pylon-cli command list --executable true --json
pylon-cli registry list --json
pylon-cli command inspect file.text.read --json
pylon-cli command exec file.text.read --args '{"sessionId":"sabc","path":"src/App.tsx"}' --json
pylon-cli command exec presentation.apply --args '{"profileId":"builtin.presentation.console-glass"}'
pylon-cli command exec layout.sidebar.set --args '{"collapsed":true}'
pylon-cli command exec plugin-settings.set --args '{"pluginId":"gui.renderer","key":"density","value":"compact"}'
```

## 5. 插件作者契约

```ts
context.commands.register({
  id: 'example.reindex',
  name: 'example.reindex',
  description: '重建索引',
  permission: 'gate',
  priority: 100,
  inputHint: '{ "workspaceId": "..." }',
  execute: async ({ args, signal }) => reindex(args, signal),
})
```

要求：

- `id` 在活动 Command Registry 中唯一；
- CLI 输入输出必须可 JSON 序列化；
- 长操作消费 `signal`；
- 变更操作标记 `permission: 'gate'`；
- 不提供 `execute` 的命令只用于 Agent prompt/输入建议，`command exec` 会明确拒绝；
- 插件停用或热替换后，旧 runtime 拥有的命令自动消失。
