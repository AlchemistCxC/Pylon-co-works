# Pylon

> **基于 ACP 的可扩展 AI Agent 桌面工作台。**

Pylon 是一个面向 **AI Agent 用户** 的 GUI 客户端。

它通过 **ACP（Agent Communication Protocol）** 与兼容 Agent 通信，把原本运行在终端中的 Agent 带入一个完整的桌面环境：会话、文件、工具调用、权限控制、界面定制、插件、上下文系统与平台网关，都可以围绕 Agent 组合起来。

Pylon 不绑定特定模型，也不绑定特定 Agent。

只要 Agent 能够通过 ACP 与客户端通信，就可以接入 Pylon。

```text
Agent
  │
  │ ACP
  ▼
Pylon
  ├─ 会话
  ├─ 文件工作区
  ├─ 工具调用
  ├─ 上下文
  ├─ 插件
  ├─ Gateway
  └─ GUI / CLI 控制面
```

Pylon 这个名字本身也代表它的设计目标：

> **一座输电塔。**

Agent 提供智能能力，Pylon 负责连接、承载、转发和扩展。

---

## 项目状态

> **Beta**

Pylon 已经能够作为日常 ACP Agent 客户端使用，但部分功能仍处于快速迭代阶段。

当前重点包括：

* ACP 通信与兼容性
* Agent 桌面交互
* 文件工作台
* Plugin API
* Gateway
* 上下文系统
* 外观与布局定制

部分计划中的能力尚未完全接通，例如真正的多 Agent 同时在线。

---

## 为什么使用 Pylon？

直接从终端运行 Agent 很简单，但当 Agent 成为长期使用的工作工具后，通常还会需要更多东西：

* 会话管理
* 文件浏览
* 工具调用可视化
* 权限控制
* 上下文状态
* 自定义界面
* 插件
* 平台消息接入
* 持久化
* 调试能力

Pylon 的目标，就是把这些能力放到 Agent 周围，而不是重新实现一个 Agent。

### 不绑定具体 Agent

Pylon 不要求用户选择某一家固定的 Agent 或模型厂商。

只要 Agent 支持 ACP，就可以通过统一的协议接入。

这意味着用户可以保留自己的 Agent，同时获得统一的桌面交互环境。

### 高度可定制

Pylon 提供大量外观与布局设置。

除了预设主题，还可以进一步修改界面的不同区域、组件与布局。

Pylon 同时提供 CLI 控制面，可以通过命令修改应用中的大量状态和配置。

对于希望构建高度个性化工作环境的用户，Pylon 不只是一个固定布局的聊天窗口。

### 插件扩展

Pylon 的插件系统不仅能修改界面。

插件还可以在 Agent 接入后，为 Pylon 注册额外能力，并通过 **工具注入** 将这些能力提供给 Agent。

因此：

```text
Agent 原生能力
      +
Pylon 内置能力
      +
Pylon 插件能力
      =
最终工作环境
```

### Gateway

Gateway 让 Pylon 不只是一个桌面 GUI，也可以成为 Agent 与其他平台之间的中转层。

```text
平台
  │
  ▼
Pylon Gateway
  │
  ▼
ACP
  │
  ▼
Agent
```

因此同一个 Agent 可以被用于：

* 桌面私人助手
* 私聊机器人
* 群聊 Bot
* TRPG 主持人
* 其他消息平台上的 Agent 服务

---

# ACP

## ACP 是 Pylon 的核心边界

Pylon 自身不包含 Agent。

它负责通过 ACP 与外部 Agent 建立连接。

典型生命周期：

```text
Pylon
  │
  ├─ spawn agent
  │
  ├─ initialize
  │
  ├─ session/new
  │      └─ sessionId
  │
  ├─ session/prompt
  │      └─ streaming response
  │
  └─ session/close
```

Pylon 的核心目标之一，是尽可能完整地实现 ACP 客户端能力。

---

## ACP 兼容层

现实中的 ACP Agent 并不一定拥有完全一致的行为。

部分 Agent 会在标准 ACP 基础上增加自己的字段、工具语义、启动方式或能力变体。

因此 Pylon 在协议实现之外增加了一层 **Agent Catalog / Compatibility Dictionary**。

第一方兼容定义统一维护在：

```text
shared/agent-catalog.json
```

它负责描述例如：

* Agent 身份
* Provider
* ACP 探测入口
* 启动方式
* 默认协议能力
* 工具语义
* Agent 特有兼容行为

如果某个 Agent 存在 ACP 变体，可以通过显式修改兼容字典进行适配，而不需要修改整个 Pylon ACP 实现。

---

## 能力覆盖关系

Agent 的最终能力不是只依赖静态配置。

Pylon 使用分层覆盖机制：

```text
默认能力
   ↓
Agent Catalog / 实例配置
   ↓
ACP initialize 实际暴露能力
```

优先级越往下越高。

也就是说：

> **Agent 在 initialize 阶段实际暴露的能力拥有最高优先级。**

这样既可以为已知 Agent 提供合理的默认兼容配置，又允许 Agent 在运行时告诉 Pylon 自己真正支持什么。

---

## 已知 Agent

Pylon 不自带 Agent。

用户需要准备能够运行的 ACP Agent。

目前已有多种 Agent 提供 ACP 支持，例如：

* OpenClaw
* Claude Code
* Hermes
* Peri

其中部分 Agent 已经拥有 Pylon 内置兼容定义，可以减少额外配置工作。

具体兼容程度仍取决于 Agent 自身版本和 ACP 实现。

---

# 快速开始

## 1. 下载

Pylon 通过 GitHub Releases 分发。

前往：

[GitHub Releases](../../releases)

下载对应版本并解压。

---

## 2. 准备 Agent

Pylon 本身不包含模型，也不包含 Agent。

你需要准备一个能够通过 ACP 工作的 Agent。

```text
Pylon ≠ Agent
Pylon ≠ LLM
Pylon = Agent Client / Workbench
```

---

## 3. 配置 Agent Runtime

Agent 配置位于：

```text
agents.yaml
```

示例：

```yaml
agents:
  peri:
    name: Peri
    provider: peri
    transport: subprocess
    exe: C:\path\to\peri.exe
    args: ["acp"]
    model: deepseek-v4-flash
    default: true

  hermes:
    name: Hermes
    provider: hermes
    transport: subprocess
    exe: C:\path\to\hermes.exe
    args: ["acp"]
    hermes_profile: riccati
    set_model_api: true
    acp:
      prompt_timeout_secs: 180
```

`prompt_timeout_secs` 是单步闲置超时：分析、思考或工具步骤每次收到 ACP 活动都会重新计时，不会限制整轮回合的总时长。需要时可用 `idle_timeout_secs` 单独覆盖单步闲置窗口。

将 `exe` 修改为对应 Agent 的实际可执行文件路径。

配置来源优先级：

```text
PYLON_AGENTS_CONFIG
        ↓
exe 同目录 agents.yaml
        ↓
内置默认配置
```

也可以在 Pylon 中打开：

```text
设置 → Agent
```

直接编辑并保存 Agent 配置。

---

## 4. 开始工作

启动 Pylon 后：

```text
选择 Agent
   ↓
启动 Runtime
   ↓
ACP initialize
   ↓
创建 Session
   ↓
开始对话
```

---

# Agent Runtime

当前主要使用：

```text
subprocess
```

模式启动 Agent。

也就是说：

```text
Pylon
  │
  ├─ 启动 Agent 原生进程
  │
  ├─ 建立 ACP 通信
  │
  └─ 管理 Agent 生命周期
```

Agent 后端仍然是自己的原生程序。

Pylon 的 Rust 后端与 Agent Runtime 都可以保持为原生二进制运行，而不是把 Agent 本身封装进 Web 前端。

未来计划继续增加其他 Agent Transport。

---

# 多 Agent

Pylon 已经支持导入和维护多个 Agent 配置。

例如：

```text
Agents
├─ Agent A
├─ Agent B
├─ Agent C
└─ Agent D
```

当前版本的限制是：

> **可以管理多个 Agent，但同时实际连接的 Agent 只有一个。**

真正的多 Agent 同时在线与并行协作仍属于后续开发方向。

---

# Agent 工作台

## 会话

Pylon 提供面向 ACP Session 的图形化会话环境。

包括：

* 会话创建
* 会话切换
* 流式回复
* 消息恢复
* 思考块显示
* 工具调用卡片
* 代码高亮
* ANSI 输出
* Session 状态管理

---

## 思考块

Agent 返回的 reasoning / thought 内容可以独立显示和折叠。

这让：

```text
Agent 思考
```

和：

```text
Agent 最终回复
```

在 UI 上保持清晰分离。

### 已知问题

Beta 版本中，快速切换会话时，偶尔可能出现：

> 思考块显示位置不正确。

该问题属于当前已知的 UI 状态同步问题之一。

---

# 文件工作台

Pylon 提供与 Agent 会话结合的文件工作区。

支持：

* 文件树
* 文本编辑
* UTF-8
* GBK
* Git status
* Git diff
* Git history
* 全文搜索
* 将文件发送给 Agent
* 将选中代码发送给 Agent

Git 相关能力目前主要用于只读检视。

文件工作区的目标不是把 Pylon 做成完整 IDE，而是让：

```text
文件
  ↓
上下文
  ↓
Agent
```

之间的交互更加直接。

---

# 工具调用与权限

Agent 可以通过 ACP 请求执行工具。

Pylon 会将工具调用显示为独立 UI，并根据当前权限模式决定是否要求用户确认。

目前支持：

* `default`
* `auto`
* `edit`
* `bypass`

工具审批支持超时拒绝。

这样即使 Agent 拥有工具能力，用户仍可以在 GUI 层观察和控制实际执行过程。

---

# Pylon Kernel

当前实现的 Kernel/插件层地图、关键调用链、已知风险和后续定向阅读规则见 [`docs/Pylon-项目架构参考.md`](docs/Pylon-项目架构参考.md)。

Pylon 的架构并不是：

```text
一个巨大应用
```

而更接近：

```text
Minimal Kernel
      +
First-party Plugins
      +
Third-party Plugins
```

Kernel 只保留应用运行所必需的核心能力。

主要包括：

* 会话管理
* ACP 通信
* 数据持久化
* 基础生命周期
* 插件运行环境

大量用户直接看到的功能实际上位于插件层。

例如：

* 外观
* 布局
* 工作区
* Renderer
* Widget
* 产品功能

即使是 Pylon 自带功能，也可以作为 **第一方插件** 存在。

---

# Plugin API

Pylon 提供 **Plugin API 1.0**。

插件不仅可以添加一个按钮或一张面板，也可以参与 Pylon 的核心运行流程。

## 生命周期 Hook

当前开放的 Hook 包括：

```text
创建会话
回复前
回复后
工具调用前
工具调用后
```

插件可以利用这些生命周期事件实现：

* 上下文处理
* 消息预处理
* 消息后处理
* 工具观察
* 工具拦截
* 状态同步
* 自动化工作流
* 自定义 Agent 行为

---

## 工具注入

插件可以向 Pylon 注册新的工具能力。

然后这些工具可以被暴露给已经连接的 Agent。

```text
Plugin
   │
   ├─ 注册 Pylon Tool
   │
   ▼
Pylon Tool Registry
   │
   ▼
ACP Agent
```

因此插件系统不仅扩展 GUI，也可以扩展 Agent 能够使用的实际能力。

---

## UI 扩展

插件可以参与：

* Workspace
* Renderer
* Hook
* Command
* Stylesheet
* 外部 Process
* Widget
* 布局

这意味着 Pylon 的界面本身也可以被重新组合。

---

## 插件包

插件根目录：

```text
<config_root>/pylon/plugins/
```

内部包含：

```text
plugins/
├── packages/
├── data/
├── runtime/
├── transactions/
└── state.json
```

不要手工修改 active pointer 或事务文件。

---

## 插件生命周期

插件支持：

* 安装
* 启用
* 停用
* 重新加载
* 更新
* 卸载
* 多版本存储

启用状态会持久化，并在 Pylon 启动时恢复。

---

## Shadow Update

插件更新使用候选实例和 Shadow Registry。

新版本不会立即破坏正在工作的旧实例。

大致流程：

```text
当前插件
   │
   ├──────────────┐
   │              │
   ▼              ▼
继续运行      创建候选版本
                  │
                  ▼
              Shadow Load
                  │
          ┌───────┴───────┐
          │               │
        成功             失败
          │               │
          ▼               ▼
       切换版本        保留旧版本
```

如果更新失败：

```text
旧实例      保留
旧样式      保留
旧进程      保留
active      保持旧版本
```

---

## PluginScope

插件使用 `PluginScope` 管理自身资源。

例如：

* 样式
* Runtime
* 注册项
* 外部进程
* 生命周期资源

插件停用或卸载时，相关资源可以随 Scope 一起回收。

---

## 插件安全模型

Pylon 当前没有插件权限沙箱。

也没有：

* 插件权限鉴定
* 签名商店
* 恶意代码沙箱

因此当前安全模型非常明确：

> **安装一个插件，就等于完全信任这个插件。**

插件可能运行代码、启动外部进程或参与应用生命周期。

只安装你能够信任来源和代码的插件。

---

## 插件文档

完整插件设计和开发方式请参考：

* [插件系统说明书 · 用户版](docs/说明书/Pylon-插件系统说明书-用户版.md)
* [插件系统说明书 · 开发者版](docs/说明书/Pylon-插件系统说明书-开发者版.md)

示例：

```text
examples/process-plugins/
examples/update-plugins/
```

---

# 外观系统

外观自定义是 Pylon 的核心能力之一，而不是附属功能。

Pylon 的主题系统由 CSS Variables 驱动。

目前包含预设：

* Claude
* Glass Light
* Nord Frost

同时支持进一步自定义不同 UI 区域。

Pylon 的目标不是只提供几个：

```text
Dark / Light
```

开关，而是允许用户真正构建自己的 Agent 工作环境。

---

# Widget 工作台

中控区域使用可拖拽 Widget 组织。

例如可以包含：

* 输入栏
* 上下文指示器
* Token 信息
* 当前模型
* 权限模式
* 任务状态
* 其他插件 Widget

用户可以像组织画布一样重新排列这些元素。

例如：

```text
┌────────────────────────────────────────────┐
│                 Context                    │
├───────────────┬────────────────────────────┤
│               │                            │
│   Sessions    │          Chat              │
│               │                            │
├───────────────┴────────────────────────────┤
│ Token │ Model │ Permission │ Task Status   │
├────────────────────────────────────────────┤
│                  Input                     │
└────────────────────────────────────────────┘
```

也可以重新排列成完全不同的布局。

---

# CLI 控制面

Pylon 提供命令行控制能力。

CLI 不只是用于启动程序，也可以控制和修改应用中的大量状态。

这使 Pylon 可以同时拥有两种入口：

```text
GUI
 │
 ├──────────┐
 │          │
 ▼          ▼
User      CLI / Automation
 │          │
 └────┬─────┘
      ▼
   Pylon
```

因此外部脚本、插件或自动化系统也可以参与工作台控制。

---

# Prism 世界书

Pylon 包含面向长上下文与角色设定场景的世界书系统。

## 什么是世界书？

世界书本质上是一组：

```text
关键词
   +
对应设定
```

组成的结构化数据。

可以理解为：

> 一个世界、角色或故事背景的设定数据库。

例如一份世界书可以包含：

```text
地点
角色
组织
历史
物品
规则
事件
```

每条内容都有对应的关键词。

---

## 动态注入

用户发送消息后，Pylon 会根据消息内容匹配世界书关键词。

```text
用户消息
   │
   ▼
关键词匹配
   │
   ▼
命中世界书条目
   │
   ▼
注入对应设定
   │
   ▼
Agent
```

因此不需要每一轮都把整个世界设定发送给 Agent。

只有相关设定会在需要时被注入。

这样可以获得更强的：

* 世界观锚定
* 角色一致性
* 长期剧情一致性
* 上下文利用效率

---

## 回合持久化

世界书系统同时支持回合状态持久化。

其主要用途包括：

* 战报系统
* 会话回放
* 长期剧情恢复
* 上下文状态追踪

这使它不仅适用于普通聊天，也适用于：

* TRPG
* 长篇角色扮演
* Galgame
* 世界模拟
* 长期角色 Agent

---

# Gateway

Gateway 是 Pylon 的另一个核心扩展方向。

基本消息链：

```text
Platform
   │
   ▼
Pylon Gateway
   │
   ▼
ACP
   │
   ▼
Agent
```

Agent 不需要直接为每个平台重新实现自己的业务逻辑。

Pylon 可以承担平台适配与消息转发层。

---

## 当前场景

例如：

### 私人 Agent 助理

```text
私聊
 ↓
Pylon
 ↓
Agent
```

### 群聊 Bot

```text
群成员
  ↓
QQ群
  ↓
Pylon
  ↓
Agent
```

### TRPG 主持人

```text
玩家
  ↓
群聊
  ↓
Pylon
  ↓
世界书 / 会话状态
  ↓
Agent
  ↓
主持回复
```

---

## 当前 Gateway 能力

包括：

* 群聊路由
* 私聊路由
* 长回复分段
* 消息重放去重
* 断线重连

---

# 终端宠物

Pylon 内置像素风格的终端宠物。

它不是一个完全独立于 Agent 的装饰动画。

宠物状态可以跟随：

* Agent 状态
* 用户状态
* 当前活动

发生行为变化。

例如：

> 当 Agent 正在生成代码时，宠物可能会一起敲代码，或者直接开始啃代码。

目前包含：

* 五阶成长
* 七种情绪
* 随机性格
* 状态持久化

它不会提高模型 Benchmark。

但 Benchmark 也不会在你调 Bug 的时候陪你。

---

# 数据与持久化

Pylon 的会话恢复数据保存在本地。

Pylon 自己负责维护会话恢复所需要的信息，例如消息标识和消息顺序。

Agent 自己产生或管理的数据则由对应 Agent 自己负责。

```text
Pylon 数据
   │
   └─ Pylon 本地存储

Agent 数据
   │
   └─ 由对应 Agent 自己管理
```

Pylon 不替 Agent 决定：

* Agent 是否连接云端
* Agent 调用什么模型
* Agent 如何保存自己的数据
* Agent 将内容发送到哪里

这些行为取决于用户实际接入的 Agent。

---

# 会话持久化

Pylon 使用 SQLite 管理本地会话状态和事件数据。

支持：

* Session 恢复
* 事件顺序
* 全文搜索
* 保留策略
* 按时间清理
* 按数量清理

---

# Portable 模式

Pylon 支持便携模式。

当 EXE 同目录存在：

```text
portable.flag
```

或者：

```text
data/
```

目录时，运行数据会写入：

```text
<exe目录>/data/
```

其中可以包含：

* SQLite
* 插件
* MCP
* Gateway
* Pet 状态

因此可以直接复制整个目录迁移工作环境。

---

## Portable 回退

如果没有启用 Portable：

```text
Pylon
  ↓
系统 AppData / AppConfig
```

如果启用了 Portable，但目录不可写，例如：

```text
只读介质
Program Files
```

Pylon 会自动回退到系统数据目录并记录日志。

---

# 运行监控

Pylon 在 Agent 启动时会同时拉起运行监控终端。

该终端用于观察 Agent Runtime 的运行状态与错误输出。

当 ACP Agent：

* 启动失败
* 运行异常
* 输出错误
* 通信出现问题

时，可以直接通过监控终端进行排查。

---

# 技术架构

Pylon 基于 Tauri。

```text
┌──────────────────────────────────────┐
│                UI                    │
│                                      │
│ React / SolidJS / Plugin Renderer    │
└──────────────────┬───────────────────┘
                   │
               Tauri IPC
                   │
┌──────────────────▼───────────────────┐
│            Rust Backend              │
│                                      │
│ ACP                                  │
│ Session                              │
│ Persistence                          │
│ Gateway                              │
│ Plugin Runtime                       │
│ Process Supervision                  │
└──────────────────┬───────────────────┘
                   │
                   │ ACP
                   ▼
┌──────────────────────────────────────┐
│            External Agent            │
│                                      │
│ Native Process                       │
└──────────────────────────────────────┘
```

后端使用 Rust，并编译为原生二进制。

---

# 技术栈

| 层              | 技术                                    |
| -------------- | ------------------------------------- |
| Desktop        | Tauri 2                               |
| Backend        | Rust                                  |
| Async Runtime  | tokio                                 |
| Frontend       | TypeScript 5 · React 19 · SolidJS 1.9 |
| Build          | Vite 6                                |
| State          | Zustand 5                             |
| Markdown       | react-markdown                        |
| Code Highlight | starry-night                          |
| Database       | SQLite / rusqlite                     |
| ACP            | agent-client-protocol-schema          |
| HTTP           | reqwest                               |
| WebSocket      | tokio-tungstenite                     |
| Test           | vitest · Rust Test · CLI Test         |

---

# WebView2

Pylon 的桌面界面基于 Tauri，因此当前运行环境需要 WebView2 Runtime。

在通常已经自带 WebView2 Runtime 的 Windows 环境中，可以直接运行。

如果目标机器不存在 WebView2 Runtime，则需要先安装对应 Runtime。

安装包构建已配置 WebView2 Bootstrapper 引导能力。

---

# 从源码运行

## 前端 Mock

```bash
npm run dev
```

用于仅启动前端界面和 Mock 环境。

---

## Tauri 开发模式

```bash
npm run tauri dev
```

启动：

```text
Frontend
   +
Rust Backend
   +
Tauri
```

并支持前端热更新。

---

# 构建

## 前端

```bash
npm run build
```

---

## Rust

```bash
cd src-tauri
cargo test --lib
cargo build
```

---

## Desktop Installer

```bash
npx tauri build
```

用于生成桌面安装包。

---

## 完整质量检查

```bash
npm run check:all
```

---

# 开发与测试

前端测试：

```bash
npm test
```

Rust 测试：

```bash
cd src-tauri
cargo test --lib
```

Lint：

```bash
npm run lint
```

TypeScript：

```bash
npx tsc -b
```

完整检查：

```bash
npm run check:all
```

---

# 项目结构

```text
prism-desktop/
├── src/
│   ├── app/
│   │   └── application/
│   │       # bootstrap 与应用事务
│   │
│   ├── components/
│   │   # UI Components
│   │
│   ├── domains/
│   │   # theme / permission / tool
│   │   # tasks / events / workbench
│   │
│   ├── infrastructure/
│   │   # typed client + wire normalize
│   │
│   ├── plugin-runtime/
│   │   # Plugin API Runtime
│   │   # Scope / Registry / Hook / Process
│   │
│   ├── plugins/
│   │   ├── product/
│   │   │   # 第一方产品插件
│   │   └── core/
│   │       # 第一方领域插件
│   │
│   ├── sheets/
│   ├── workspace-sheets/
│   └── renderers/
│       └── solid-workbench/
│
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs
│   │   │   # AppState / Bootstrap / Commands
│   │   │
│   │   ├── acp/
│   │   │   # ACP Client
│   │   │   # Protocol / Transport / Process
│   │   │
│   │   ├── session/
│   │   │   # Session / Message / Event
│   │   │
│   │   ├── lifecycle/
│   │   ├── dispatcher/
│   │   ├── gateway/
│   │   │   # Platform Gateway
│   │   │
│   │   └── plugin_cmds.rs
│   │       # Plugin Package / Transaction
│   │
│   └── pet-core/
│
├── shared/
│   └── agent-catalog.json
│       # Agent Compatibility Dictionary
│
├── examples/
│   ├── process-plugins/
│   └── update-plugins/
│
├── docs/
│   ├── 说明书/
│   └── 插件化改造/
│
├── agents.yaml
│
└── scripts/
```

---

# 当前限制

Pylon 目前处于 Beta 阶段。

已知限制包括：

### 多 Agent

可以导入和配置多个 Agent，但当前同时连接的 Agent 只有一个。

真正的多 Agent 并行连接仍在开发计划中。

### 思考块

切换 Session 时，偶尔可能出现思考块位置不正确。

### Agent 差异

虽然 Pylon 以 ACP 为统一协议，但不同 Agent 仍可能存在自己的协议变体。

对于这种情况，需要通过兼容字典或 Agent 实例配置进行适配。

### 插件安全

当前没有插件权限沙箱。

安装插件等于完全信任插件代码。

---

# Roadmap

目前主要开发方向包括：

## Multi-Agent

从：

```text
配置多个 Agent
但同时只连接一个
```

逐步发展为：

```text
多个 Agent
   │
   ├─ 同时连接
   ├─ 独立 Session
   ├─ 并行任务
   └─ Agent 协作
```

---

## Galgame Mode

强化角色 Agent 与长期剧情场景的沉浸体验。

计划继续结合：

* 世界书
* 角色状态
* 回合持久化
* UI Renderer
* 场景表现
* 角色交互

构建更加完整的沉浸式 Agent 体验。

---

## Workbench

继续强化工作台能力：

* 文件
* 上下文
* Widget
* Renderer
* Task
* Tool
* Plugin

让 Pylon 不只是：

```text
Agent Chat GUI
```

而是：

```text
Agent Workbench
```

---

## Agent Transport

当前主要使用 subprocess。

未来计划增加其他 Agent Transport，以支持更多运行方式和远程 Agent 场景。

---

# 贡献

目前项目欢迎以下类型的贡献。

## ACP 兼容性反馈

如果某个 Agent：

* 无法 initialize
* ACP 字段存在差异
* 工具语义不同
* Session 行为异常
* 存在厂商特有扩展

欢迎提交兼容性反馈。

这类反馈可以帮助完善：

```text
shared/agent-catalog.json
```

以及 Pylon 的 ACP Compatibility Layer。

---

## 插件

欢迎开发：

* Workspace 插件
* Renderer
* Widget
* Hook
* Command
* Tool
* Process Plugin
* 外观插件
* Agent Workflow 插件

插件系统本身就是 Pylon 最主要的扩展接口之一。

---

# 文档

正式说明书位于：

```text
docs/说明书/
```

插件系统相关文档：

* [插件系统说明书 · 用户版](docs/说明书/Pylon-插件系统说明书-用户版.md)
* [插件系统说明书 · 开发者版](docs/说明书/Pylon-插件系统说明书-开发者版.md)

插件架构和开发记录：

```text
docs/插件化改造/
```

---

# Pylon 的设计方向

Pylon 不试图成为另一个封闭的 AI 客户端。

它更希望保持几条清晰的边界：

```text
模型由模型提供商负责
Agent 由 Agent 开发者负责
协议由 ACP 连接
Pylon 负责桌面环境与扩展
```

因此 Pylon 的核心价值并不只是：

> “给 Agent 加一个聊天窗口。”

而是：

> **在 Agent 与用户之间提供一个可组合、可扩展、可观察、可控制的桌面运行环境。**

再通过 Gateway：

> **在 Agent 与外部平台之间提供一个统一中转层。**

最终形成：

```text
                    ┌──────────────┐
                    │   Platform   │
                    └──────┬───────┘
                           │
                        Gateway
                           │
                           ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│     User     │────▶│    Pylon     │◀───▶│  ACP Agent   │
└──────────────┘     └──────────────┘     └──────────────┘
                           │
             ┌─────────────┼─────────────┐
             │             │             │
             ▼             ▼             ▼
          Plugins       Workspace      Context
```

Pylon 是其中的工作台、扩展层，也是中转站。

---

# License

MIT
