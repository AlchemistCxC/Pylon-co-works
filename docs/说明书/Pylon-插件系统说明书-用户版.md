# Pylon 插件系统说明书（用户版）

> 适用版本：Pylon 1.5.9
>
> 插件契约：Plugin API 1.0 / 1.1 / 1.2，`pylon-plugin.json` schema 1

这份说明书写给安装和管理插件的用户。插件作者请阅读[开发者版](Pylon-插件系统说明书-开发者版.md)。

---

## 1. 插件能做什么

Pylon 插件可以在不修改主程序的情况下扩展工作台，例如：

- 增加命令；
- 监听或变换会话、消息、Turn、工具调用生命周期；
- 注册 Workspace 类型；
- 增加消息、内容、工具或代码高亮渲染器；
- 增加 Presentation Profile、字体、左右栏、上下文面板或 File Workbench 功能；
- 提供自己的设置页，或为宿主已有设置添加、修改、删除候选项；
- 提供搜索、导出、事件投影等服务；
- 保存插件自己的 Session / Turn 元数据；
- 在新会话中冻结插件贡献的 Skill/首轮指令，并在连接 Agent 前准备 MCP、浏览器或电脑操作能力；
- 携带 CSS、图片、字体、WASM 等资源；
- 携带并启动本地外部程序，通过 stdio / JSON-RPC 通信。

插件不是模型，也不是 Agent。Agent 通过 ACP 连接；插件扩展的是 Pylon 工作台自身。

---

## 2. 安全提醒

Plugin API 1.0 不使用旧版的 `trust`、`signature` 或 Ed25519 白名单字段。API 1.2 起
`capabilities` 字段以新语义回归：插件声明宿主能力、由用户在授权卡中逐项批准（见 §5.1），
而不是旧版的静态白名单声明。

这意味着：

- 安装插件等于允许其前端代码在 Pylon WebView 中运行；
- 插件可以按其 manifest 启动随包附带的程序；
- 插件 CSS 可能影响工作台页面；
- Pylon 会监管插件的注册项、样式、监听器和进程生命周期，但这不等于恶意代码沙箱。

只安装来源可信、内容可审查的插件。不要安装来历不明的插件包。

---

## 3. 安装插件

### 3.1 准备插件目录

一个可安装目录至少应包含：

```text
my-plugin/
├─ pylon-plugin.json
└─ index.js
```

实际入口文件名由 `pylon-plugin.json` 的 `web.entry` 指定。插件也可以包含：

```text
styles/
assets/
resources/
bin/
```

### 3.2 从 Pylon 安装

1. 启动 Tauri 桌面版 Pylon；
2. 打开“设置”；
3. 进入“插件”；
4. 点击“安装/更新 api=1.0 包…”；
5. 选择插件源码或构建产物所在的目录；
6. 等待“安装/更新成功”日志。

安装/更新只有在 required dependency、版本、依赖环和 conflict 硬契约全部满足时才会成功，失败不会先改写现有安装。成功安装的插件默认保持启用；manifest 声明的激活事件已经发生时会创建运行实例，否则显示“等待激活事件”。已有安装状态若因环境变化不再满足契约，列表会显示“契约阻止”。下次正常启动时，Pylon 会在 `kernel.ready` 后恢复符合条件的已启用插件。

浏览器 Mock 预览不提供原生插件包安装能力，必须使用 Tauri 桌面版。

---

## 4. 插件列表怎么看

“设置 → 插件”会分别显示：

- `first-party`：Pylon 自带的第一方产品插件；
- 外置 API 1.0 插件包。

每个激活实例会显示：

```text
插件版本
packageInstanceId
runtimeInstanceId
```

三个 id 的含义：

| 字段 | 含义 |
|:--|:--|
| plugin id | 插件的稳定名称，例如 `process.json-rpc-echo` |
| package instance | 某一份不可变安装包版本 |
| runtime instance | 本次启动、启用或重载产生的运行实例 |

同一个插件重载后，runtime instance 会变化，这是正常现象。

状态含义：

| 状态 | 含义 |
|:--|:--|
| 运行中 | 已有活动 Runtime 实例 |
| 等待激活事件 | 包已启用，但尚未收到 manifest 声明的激活事件 |
| 契约阻止 | required dependency、版本、依赖环或 conflict 不满足 |
| 启动失败 | 激活或 Kernel bootstrap 失败，可以按界面提示重试 |
| 清理失败 | 停用只完成了一部分，仍有明确资源残留 |
| 安全模式未启动 | Kernel 正在运行，但 Product Plugin 没有自动启动 |

---

## 5. 管理操作

### 启用

把已安装插件标记为启用，并在契约满足、激活事件已发生时创建 Runtime。若实际激活失败，Pylon 会恢复为停用状态；若只是等待事件，仍保持启用但暂时没有 Runtime。

缺少 required dependency、依赖版本不匹配、依赖成环或与另一个已启用插件冲突时，操作会被拒绝并显示逐插件诊断。

### 停用

立即停止插件接收新的调用，并回收它拥有的资源，包括：

- 命令、Hook、Workspace、Renderer、Service 注册；
- Presentation Profile、字体、设置页与设置选项贡献；
- 会话创建贡献、编译器与 preflight handler；
- 左右栏、上下文面板、File Workbench 与 UI Surface；
- 插件 stylesheet；
- DOM / Tauri 事件监听器；
- timer、AbortController；
- 插件附带进程；
- runtime 临时目录。

停用不会删除插件包，也不会默认删除插件持久数据。

如果 deactivate hook 或某个资源释放失败，Pylon 不会把操作显示为成功。插件进入“清理失败”，列表会显示残留资源和“重试清理”按钮；清理完成前不能再次停用或卸载。仍被其他已启用插件依赖的插件也不能停用。

### 重新加载

为插件创建新的 runtime instance，并按插件声明的热切换模式更新。

成功时：

- 新实例接管；
- 旧实例排空并回收；
- 旧样式与旧进程不会继续残留。

失败时，事务会回滚，旧实例继续工作。

### 安装/更新

选择同一个 plugin id 的新目录时，Pylon 会走 Shadow Update：先准备候选版本，候选成功后才切换 active version。

### 卸载

先完成停用，再删除安装包。仍被其他已启用插件依赖、或仍有 cleanup residual 时，卸载会被阻止，不会留下“包已删但资源仍运行”的分裂状态。默认保留插件数据；当前设置页的普通“卸载”不会执行 purge data。

### 刷新

重新读取当前安装列表和运行状态，不等于从任意手工目录重新扫描插件源码。

---

## 5.1 能力授权（Plugin API 1.2 新增）

从 Plugin API 1.2 起，插件可以在清单里**声明**它需要的宿主能力（当前只有 `plugin.management`，
即插件管理面）。声明了能力但尚未获得你批准的插件不会被激活——插件列表会显示
"等待能力授权"，"启动故障"区会出现可重试的 `capability-consent` 条目；外置包安装后
则显示 `plugin_capability_denied`。

批准入口在「设置 → 插件」页顶部的**能力授权卡**：

- **批准**：授权立即生效，宿主自动重试激活该插件；
- **拒绝**：插件保持未激活，随时可以再批准。

授权规则（宿主自动执行，无需手动管理）：

- 授权与插件**版本绑定**——插件更新版本后旧授权失效，需要重新批准；
- **卸载**插件时授权自动回收；
- 授权数据保存在本机宿主存储中，不会同步，也不进入任何插件可写的数据区；
- 本机存储不可用时所有能力请求一律拒绝（安全优先）。

已授权插件的增强面板（如内置的"插件管理器（增强）"或外置示例包）会出现在插件设置页；
未授权时这些面板只显示授权引导，不会报错。声明了 `plugin.management` 的插件
**不能管理它自己**（防自拆），也不能停用产品运行必需的内置组件。

---

## 6. 热切换模式

插件可声明四种模式：

| 模式 | 用户感知 |
|:--|:--|
| `parallel` | 新旧实例短暂并存，候选成功后无缝切换 |
| `exclusive` | 旧实例需要先挂起，可能出现短暂不可用 |
| `soft-remount` | Pylon Application 子树重新挂载，Kernel 不退出 |
| `restart-required` | 不能在当前 WebView 内完成切换，需要重启或重载 |

设置页的“Shadow Update 诊断”会显示声明模式和实际采用模式。

---

## 7. 插件数据放在哪里

插件根目录由 Pylon 自动管理：

```text
<config_root>/pylon/plugins/
├─ packages/       # 不可变多版本安装包
├─ data/           # 插件持久数据
├─ runtime/        # 当前运行实例临时目录
├─ transactions/   # 安装/更新事务与 staging
└─ state.json      # 启用状态、active version、版本历史等
```

Windows 非便携模式的 `<config_root>` 通常位于当前用户的 AppConfig / Roaming 配置目录。

便携模式下，插件数据会随 Pylon 的便携数据根目录保存。

不要手工修改：

- `state.json`；
- `transactions/`；
- `packages/` 内的 package instance；
- 正在运行的 `runtime/` 目录。

手工修改可能破坏 active pointer、版本历史或事务恢复。

---

## 8. 插件样式

外置插件可在 manifest 中声明：

```json
{
  "web": {
    "entry": "./index.js",
    "styles": ["./styles/main.css"]
  }
}
```

Pylon 会：

1. 先预加载候选 stylesheet；
2. 入口模块激活成功后再启用样式；
3. 激活失败时删除候选样式；
4. 停用、重载或更新成功完成 cleanup 时随 PluginScope 删除旧样式；释放失败会进入“清理失败”并允许重试。

Pylon 当前不提供 CSS selector 沙箱。插件作者应使用插件 id 前缀或稳定 `data-*` 属性限制选择器作用域。

Pylon 有两个顶层界面模式：Modern GUI 与 Terminal-like。插件样式可以使用 `[data-interface-mode="modern-gui"]` 或 `[data-interface-mode="terminal-like"]` 只影响指定模式。切换界面模式不会停用插件，也不会切换内置主题预设（当前 10 套）。

插件可以为现有模式贡献渲染风格、字体、图标化 Workspace 和局部界面，但当前不能安装第三种完整界面模式，也不能替换整个 Agent 工作台。如果某插件把普通主题选项宣传成“完整界面模式”，应以实际可见功能为准。

### 8.1 新会话 Skill、MCP 与操作能力

插件可以在创建新会话时提供一份不可变的会话贡献快照。它可以包含首条普通消息前隐藏发送的 Skill/指令，也可以在 Agent 建立会话前启动或检查插件进程，并把 MCP server 配置交给 ACP `session/new`。

- Profile Persona 使用同一条贡献管线，并在创建会话时冻结；之后编辑 Profile 不会悄悄改写旧会话。
- 会话自己的追加提示词会叠加，不再替换 Profile Persona。
- 以 `/` 开头的命令不会消费首轮隐藏指令；首次普通消息发送失败时会保留并随重试再次发送。
- 停用或更新插件不会重写已经保存的贡献快照，但插件专属能力若仍需要其运行时 handler，停用后可能无法准备。
- “提示模型可以浏览网页”不等于拥有浏览器工具。真正的浏览器、电脑操作或 MCP 能力必须由插件进程/handler/MCP server 实际提供，并在连接 Agent 前通过校验。

---

## 9. 插件附带程序

部分插件会携带本地程序，例如索引器、转换器或后台服务。

Pylon Process Supervisor 会：

- 按当前操作系统和架构选择 executable；
- 把进程归属到具体 runtime instance；
- 收集 stdout / stderr；
- 支持 raw、lines、json-lines、JSON-RPC、HTTP 协议；
- 停用插件时先尝试优雅退出，再按超时升级终止；
- Windows 下监管整个进程树，而不只杀父进程。

如果插件停用后仍发现外部进程残留，应记录插件 id、runtime id 和进程信息后报告问题。

---

## 10. 使用 CLI 管理插件和工作台

桌面版随附 `pylon-cli`，它连接已经运行的 Pylon，可管理插件、Agent、Session、Workspace、进程和 Skin，也能执行插件贡献的命令。

```powershell
pylon-cli plugin list --json
pylon-cli command list --executable true --json
pylon-cli registry list --json
pylon-cli command exec presentation.apply --args '{"profileId":"builtin.presentation.console-glass"}'
```

插件提供可执行命令后会自动出现在 `command list`；停用插件后，其命令和其他贡献会立即从控制面消失。变更命令通常返回 `operationId`，可用 `operation inspect/logs/cancel` 跟踪。

CLI 不是离线配置编辑器：Pylon 必须正在运行。完整命令、参数和安全边界见 [Pylon CLI 命令表](Pylon-CLI-命令表.md)。

---

## 11. 故障处理

### 安装失败

检查：

- 选择的是目录而不是单个文件；
- 根目录存在 `pylon-plugin.json`；
- `api` 是否为 `1.0`/`1.1`/`1.2`；
- `schema` 是否为 `1`；
- `web.entry` 指向的文件是否存在；
- plugin id 是否只含小写字母、数字、`.`、`-`；
- 包内是否包含符号链接或非法相对路径。

### 启动后插件未激活

先看插件行上的状态和诊断，再打开“设置 → 插件 → 最近日志”：

- “等待激活事件”：当前不是错误；等待 manifest 声明的事件发生；
- “契约阻止”：按提示安装/启用正确版本的依赖，或停用冲突插件；
- “启动失败”：使用重试操作并查看最近日志；
- “安全模式未启动”：当前处于 Kernel Safe Mode，可以逐个启动或恢复正常启动。

单个外置插件失败不会让 Kernel Recovery Surface 消失；依赖该插件的其他插件可能按契约一并无法激活。

### 更新后旧版本仍在运行

查看“Shadow Update 诊断”。候选版本激活失败时，保留旧实例是正确的回滚行为。

### 插件界面没有样式

确认 manifest 的 `web.styles` 路径存在，并且 CSS 能通过 `pylon-plugin://` 资源协议读取。

### Pylon 插件启动不完整或进入安全模式

五个第一方 Product Plugin 标记为“产品运行必需”，运行中不能通过普通设置操作停用。若启动阶段某个必需插件失败，Pylon 会先显示 Kernel Recovery 界面，并提供定向重试或“进入安全模式”。安全模式不会自动启动 Product Plugin 和用户插件；可以逐个尝试启动，也可以选择“正常启动”。

### 插件显示清理失败

查看插件行列出的 resource id 和错误，先点击“重试清理”。清理完成前不要手工删除 `runtime/`、`packages/` 或 `state.json`；卸载按钮会保持不可用。如果重试仍失败，记录 plugin id、runtime instance、resource id、Hook trace 和进程日志后报告问题。

---

## 12. 当前边界

- 当前稳定契约是 Plugin API 1.0 / 1.1 / 1.2（1.1 新增插件私有存储；1.2 新增能力声明与用户授权，见 §5.1）；旧 API 0.1 已删除，不兼容旧 manifest。
- capability 词表当前只有 `plugin.management`；除能力授权卡外没有其它权限审批 UI。
- 第三方插件被视为完全可信的本机代码；Pylon 的依赖、生命周期与资源清理机制不是恶意代码沙箱。
- 安装入口是本地目录，不是 zip 商店安装。
- UI Surface、插件设置页、左右栏、上下文面板和 Host setting-option contribution 已可用；完整 Agent Workbench 替换仍是第一方边界。
- 插件删除了某个设置候选项时，Pylon 会保留已有值并标记“已不可用”，直到用户主动选择新值，不会自动篡改原设置。
- Agent Tool `pylon_cli` 可管理运行中插件、Hook、Skin、进程和 Workspace；普通用户主要使用设置页。

---

## 13. 相关文档

- [插件系统说明书（开发者版）](Pylon-插件系统说明书-开发者版.md)
- [插件设置选项贡献](../Pylon-插件设置选项贡献.md)
- [Pylon README](../../README.md)
- [Process Supervisor 示例](../../examples/process-plugins/README.md)
