# Pylon Context

Pylon 是以 ACP 连接多个本地 Agent runtime 的桌面工作台；配置实例、provider 基线与实时协议能力必须保持清晰分层。

项目结构、Kernel/插件层归属、关键调用链与定向阅读入口见 [`docs/Pylon-项目架构参考.md`](docs/Pylon-项目架构参考.md)。后续任务默认先读该文档并做局部核验，不重新进行全量架构侦察。

Kernel 加固的已确认产品决策、问题编号与施工进度见 [`docs/Pylon-Kernel-施工台账.md`](docs/Pylon-Kernel-施工台账.md)。

## Agent language

**Agent Catalog**:
版本化的第一方 provider 基线，记录身份、受控探测入口、协议默认值、交互能力和工具语义；它不是用户实例配置，也不覆盖 ACP 实时协商结果。
_Avoid_: Agent dictionary, detector table, builtin descriptor list

**Agent Profile**:
某个 provider 的有效特性视图，按 Agent Catalog 基线、Agent Instance 显式覆盖、ACP 实时协商依次收敛。
_Avoid_: Agent definition, provider config

**Agent Instance**:
`agents.yaml` 中可启动的具体 Agent 配置；同一 provider 可以有多个 Agent Instance。
_Avoid_: Agent Profile, runtime candidate

**Runtime Candidate**:
Native 受控探测发现但尚未导入为 Agent Instance 的临时结果。
_Avoid_: detected Agent, auto-imported Agent

## Rendering language

**Presentation Profile**:
一组可持久化、可由插件贡献的视觉与交互令牌，描述消息布局、输入形态、控制中心材质和配套图形资产；它不决定使用 React、Solid 或隔离 UI。
_Avoid_: renderer preset, terminal renderer

**Renderer Engine**:
把宿主语义数据挂载为可见 UI 的技术适配器，例如 React、Solid 或隔离式插件 Surface；引擎与 Presentation Profile 正交。
_Avoid_: visual style, theme preset

**Workbench Renderer**:
能够接管 AgentSheet 工作区主体（历史消息、流式输出、任务与输入）的渲染贡献，同时遵守宿主提供的语义数据、命令与生命周期边界。
_Avoid_: message row renderer, skin
