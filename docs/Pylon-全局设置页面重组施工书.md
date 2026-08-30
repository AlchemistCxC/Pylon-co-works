# 全局设置页面重组施工书

## 目标

将设置页的导航、深链和搜索入口统一到 `settingsDomains` 注册表；每个设置项保持一个清晰的域/分区归属，旧入口可继续工作但不再产生“幽灵分区”。本施工书先落地 Slice A（设置意图归一化），后续再处理标签去重与字段贡献注册。

## 现状盘点

- `src/settingsDomains.ts` 已是域、分区、标签和主题字段归属的主要真值。
- `Settings.tsx` 支持 `initialDomain`/`initialSection` 以及 `pylon:open-settings` 事件，但入口仍可发送历史值；`renderer/suite` 这类值无法对应当前注册表。
- 主题持久化迁移只负责主题字段和旧预设键，不应把导航意图混入主题 schema。
- 快速搜索索引已从主题字段和 renderer catalog 派生，但命中后需要依赖 canonical section 才能稳定跳转。

## Slice A：设置意图归一化

### 方案

新增纯函数 `normalizeSettingsIntent`，在 Settings 宿主消费初始 props 和窗口事件时调用：

- 合法 domain/section 原样保留，并校正 section 所属 domain；
- 历史 `renderer`/`suite` 路由映射到 `appearance`/`renderers`；
- 常见旧 section 别名映射到当前 section；
- 未知值回退到 `appearance`/`global`，未知插件页仍作为插件页保留；
- 不修改任何持久化主题或 workspace 数据。

### 兼容性

事件发送方无需同步升级；旧深链继续可用。canonical intent 仍只包含现有 `SettingsDomainId`、`SettingsSectionId` 和可选 `agentId`，不改变 Settings 内容组件。

### 性能预算

归一化为 O(1) 映射与一次注册表查找，仅发生在 Settings 打开或导航事件到达时；不增加渲染循环工作。

### 可观察性

保留 agentId；未知 section 不静默进入空白页，而回退到全局设置。测试覆盖旧 renderer 路由、旧 section 别名、跨域校正和未知值回退。

## 后续切片

- Slice B：重复标签/字段贡献审计，建立 canonical label 与别名（搜索可匹配别名但界面只显示 canonical label）。
- Slice C：将 renderer/plugin 贡献接入同一注册表完整性测试，并清理已失效的入口测试。
- 每个切片完成后更新问题台账和下一阶段清单；验收按用户指示暂不执行。
