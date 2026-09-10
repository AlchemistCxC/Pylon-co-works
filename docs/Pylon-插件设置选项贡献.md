# Pylon 插件设置选项贡献

插件可通过 `context.settings.registerOptions(...)` 向宿主已有的候选型设置增加、修改或删除选项。这个协议只贡献“候选项视图”；字段当前值、持久化、联动逻辑和控件渲染仍归宿主设置域所有。

设置贡献分为两类：

- `registerOptions` 只修改已有字段的候选项；
- `registerPage` 或 Context Panel contribution 可选声明 framework-neutral `SettingsSchema`。声明 schema 且提供 `SettingsValueAdapter` 时，Settings 宿主负责字段控件、条件、重置、搜索和 unavailable 展示；没有 adapter 的页面/面板保持 opaque，不由宿主猜测内部字段。

schema adapter 的最小契约是 `namespace`、`ownerPluginId`、`contributionId`、`getSnapshot()`、`setValue`、`removeValue`、`reset` 和 `subscribe`。snapshot 必须包含稳定的 `values`、`unavailable` 与单调 `revision`。Plugin Page 使用 `namespace: 'plugin-page'`，Context Panel 使用 `namespace: 'context-panel'`；宿主按 `(ownerPluginId, contributionId, fieldKey)` 隔离存储，同一插件的多个页面/面板不会共享 bucket。adapter 的 namespace 与注册身份不匹配会被拒绝。

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

## Schema 页面与结构化 target

`SettingsSchema` 复用 Renderer 的 framework-neutral 字段类型（`choice`、`multi-choice`、`color`、`number`、`boolean`、`text`），并支持 `semanticKey`、`scope`、`inheritsFrom`、`deprecated`、`aliases`、`order` 等只读 metadata。SDK 从 `@pylon/sdk` 导出 `SettingsSchema`、`SettingsField`、`SettingsValue`、`SettingsValueAdapter` 及兼容的 Renderer 类型别名。

新 API 内部使用结构化 `SettingsTarget`，而不是自行拼接字符串：

```ts
const target: SettingsTarget = {
  namespace: 'kind',
  ownerPluginId: 'acme.widgets',
  ownerId: 'acme.widgets.chart',
  fieldKey: 'accent',
}
```

需要字符串持久化时，只能使用 SDK 的 `stringifySettingsTarget` / `parseSettingsTarget`。owner、field 中的字面 `.` 会被无歧义编码；旧 `theme.<field>`、`kind.*`、`slot.*` 等点号 target 仅作为兼容入口。无法无歧义解析的旧 target 会 fail-closed，并保留原值与 diagnostic。`optionTarget`/`paletteTarget` 也必须引用同一 target grammar，不能在 UI、Store、resolver 中各自定义格式。

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

Plugin Page / Context Panel schema 的值目前不属于 Theme、Presentation 或 Renderer 三个 preset provider。模板库会将其标记为 `excluded/partial`；插件值不会被静默捕获、覆盖或丢弃。若未来需要纳入 preset，必须另行定义 provider 版本、迁移、prepare/commit/rollback 与卸载契约。

## 与 Interface Mode 的边界

`registerOptions` 只能修改宿主已声明字段的候选项视图。它不能通过向某个 select 塞入字符串来注册第三种 Interface Mode，也不能取得 Application Shell、Agent Workbench、设置字段值或模式切换事务的所有权。

插件若要适配现有界面模式，可以组合使用：

- Presentation Profile 的 `interfaceMode: 'modern-gui' | 'terminal-like'` 归属；
- Renderer、Workspace、UI Surface 等既有贡献点；
- `[data-interface-mode="modern-gui"]` / `[data-interface-mode="terminal-like"]` 作用域 CSS。

完整 Interface Mode 贡献仍未开放；在宿主定义可序列化端口与生命周期以前，不应把 Theme、Skin 或 Presentation Profile 宣称为完整模式。
