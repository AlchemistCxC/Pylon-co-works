/** @jsxImportSource solid-js */
import { createMemo, Show, Suspense, type Component } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { resolveSheetRender } from './sheetRegistry.ts'
import SheetErrorBoundary from './SheetErrorBoundary.solid.tsx'
import { getWorkspaceRegistrySnapshot, subscribeWorkspaceRegistry } from '../plugin-runtime/workspaces/workspaceRegistry'
import { createRegistrySignal } from '../infrastructure/state/solidSheetSupport.solid.tsx'
import type { SheetContext, SheetRecord } from './sheetTypes'

/**
 * SheetHost — registry 驱动主区渲染（W1-02/03）。
 *
 * activeSheet 解析与 ctx 构建上移 SheetLayout；本组件按 sheet.kind 查询完整
 * WorkspaceTypeDefinition 并渲染 component。
 * 报告 8.2：Sheet 级错误隔离（单 Sheet 崩溃不拖垮应用）。
 * #515：registry 贡献已是 Solid `Component`，实体直连渲染；registry 订阅随 memo 生效
 * （插件热换后重解析）。
 * **#520 修复（切 kind 主区滞留）**：非键控 Show 只认真值翻转——把「entry+state」包成
 * 对象当 `when`，两个都注册了 component 的 kind 互切（如 settings→runtime）时子级
 * 不重跑，旧主区组件滞留（与 SheetSidebarSlot 同族，实测报告见 #520）。修法同款：
 * 组件**身份**单独作 memo 并作为 keyed Show 的 `when`（组件引用按 kind 稳定 ⇒ 只在
 * kind/注册表变化时重挂），state 经响应式 prop 原位更新。
 */

export default function SheetHost(props: { sheet: SheetRecord; ctx: SheetContext }) {
  // sheet 对象与 ctx 都经响应式 props 到达（SheetLayout 保实例更新，见其 keep-alive 槽位）
  const registry = createRegistrySignal({ subscribe: subscribeWorkspaceRegistry }, getWorkspaceRegistrySnapshot)
  const resolvedComponent = createMemo(() => {
    registry()
    const entry = resolveSheetRender(props.sheet.kind)
    return entry?.component ?? null
  })
  const resolvedState = createMemo(() => {
    const entry = resolveSheetRender(props.sheet.kind)
    return entry ? entry.deserialize(props.sheet.state) : undefined
  })
  return (
    <Show when={resolvedComponent()} keyed fallback={<UnavailableSheet kind={props.sheet.kind} />}>
      {Component => (
        <SheetErrorBoundary sheetId={props.sheet.id}>
          <Suspense fallback={null}>
            <Dynamic
              component={Component as Component<{ sheet: SheetRecord; ctx: SheetContext; state: unknown }>}
              sheet={props.sheet}
              ctx={props.ctx}
              state={resolvedState()}
            />
          </Suspense>
        </SheetErrorBoundary>
      )}
    </Show>
  )
}

function UnavailableSheet(props: { kind: string }) {
  return (
    <div class="sheet-empty-host">
      <div class="sheet-empty-kicker">SHEET</div>
      <h2>{props.kind} 尚未接入</h2>
      <p>当前只建立了 Sheet 状态与导航壳，运行内容尚未接入。</p>
    </div>
  )
}
