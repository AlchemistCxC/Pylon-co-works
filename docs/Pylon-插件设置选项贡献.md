# Pylon 插件设置选项贡献

插件可通过 `context.settings.registerOptions(...)` 向宿主已有的候选型设置增加、修改或删除选项。这个协议只贡献“候选项视图”；字段当前值、持久化、联动逻辑和控件渲染仍归宿主设置域所有。

## 贡献示例

```ts
export function activate(context: BuiltinPluginActivationContext) {
  context.settings.registerOptions({
    id: 'acme.appearance.message-styles',
    target: 'theme.msgStyle',
    order: 200,
    remove: ['terminal'],
    upsert: [
      { value: 'bubble', label: '紧凑气泡' },
      { value: 'cards', label: '分层卡片', description: '由 Acme Renderer 提供' },
    ],
  })
}
```

- `target`：稳定设置目标；主题字段使用 `theme.<ThemeFieldKey>`，例如 `theme.globalFont`、`theme.accent`、`theme.ccVariant`。
- `remove`：先删除指定稳定值，可删除宿主选项或较早贡献的选项。
- `upsert`：同值已存在时修改 label/description/disabled/order，不存在时新增。同一贡献内先 `remove` 后 `upsert`。
- 多个插件按 Registry layer/priority/order 确定性叠加；后应用的贡献可覆盖同值的展示属性。
- 注册句柄自动绑定当前 `PluginScope`；插件停用时即时回收，热更新在与其他插件贡献相同的 shadow transaction 中原子替换。

## 当前宿主支持

- `select` 字段：增删改选项，支持禁用和描述。
- `fontPicker` 字段：与字体 Registry 候选项合并。如新值需实际字体资产，插件仍应注册 Font Contribution 或在自有样式中提供对应 CSS 变量。
- `color` 字段：贡献字段私有色板，不改动其他取色器或全局默认色板。

如当前持久值被后续贡献删除，宿主保留该值并显示“已不可用”，直到用户主动选择新值；不会悄悄改写用户配置。

## 与 Interface Mode 的边界

`registerOptions` 只能修改宿主已声明字段的候选项视图。它不能通过向某个 select 塞入字符串来注册第三种 Interface Mode，也不能取得 Application Shell、Agent Workbench、设置字段值或模式切换事务的所有权。

插件若要适配现有界面模式，可以组合使用：

- Presentation Profile 的 `interfaceMode: 'modern-gui' | 'terminal-like'` 归属；
- Renderer、Workspace、UI Surface 等既有贡献点；
- `[data-interface-mode="modern-gui"]` / `[data-interface-mode="terminal-like"]` 作用域 CSS。

完整 Interface Mode 贡献仍未开放；在宿主定义可序列化端口与生命周期以前，不应把 Theme、Skin 或 Presentation Profile 宣称为完整模式。
