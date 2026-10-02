/** @jsxImportSource solid-js */
import { createMemo, Show, Suspense, type Component } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { resolveSheetRender } from './sheetRegistry.ts'
import SheetErrorBoundary from './SheetErrorBoundary.solid.tsx'
import { getWorkspaceRegistrySnapshot, subscribeWorkspaceRegistry } from '../plugin-runtime/workspaces/workspaceRegistry'
import { createRegistrySignal } from '../sheets/solidSheetSupport.solid.tsx'
import type { SheetContext, SheetRecord } from './sheetTypes'

/**
 * SheetHost — registry 驱动主区渲染（W1-02/03）。
 *
 * activeSheet 解析与 ctx 构建上移 SheetLayout；本组件按 sheet.kind 查询完整
 * WorkspaceTypeDefinition 并渲染 component。
 * 报告 8.2：Sheet 级错误隔离（单 Sheet 崩溃不拖垮应用）。
 * #515：registry 贡献已是 Solid `Component`，实体直连渲染；registry 订阅随 memo 生效
 * （插件热换后重解析）。
 */

export default function SheetHost(props: { sheet: SheetRecord; ctx: SheetContext }) {
  // sheet 对象与 ctx 都经响应式 props 到达（SheetLayout 保实例更新，见其 keep-alive 槽位）
  const registry = createRegistrySignal({ subscribe: subscribeWorkspaceRegistry }, getWorkspaceRegistrySnapshot)
  const rendered = createMemo(() => {
    registry()
    const sheet = props.sheet
    const entry = resolveSheetRender(sheet.kind)
    if (!entry) return null
    return { entry, state: entry.deserialize(sheet.state) }
  })
  return (
    <Show when={rendered()} fallback={<UnavailableSheet kind={props.sheet.kind} />}>
      {payload => (
        <SheetErrorBoundary sheetId={props.sheet.id}>
          <Suspense fallback={null}>
            <Dynamic
              component={payload().entry.component as Component<{ sheet: SheetRecord; ctx: SheetContext; state: unknown }>}
              sheet={props.sheet}
              ctx={props.ctx}
              state={payload().state}
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
