/** @jsxImportSource solid-js */
import { createMemo, For, Show } from 'solid-js'
import { useWorkspaceStore } from '../../domains/workspace/workspaceStore'
import { useIdentityStore } from '../../domains/identity/identityStore'
import { sourcesForPath } from '../../domains/file/fileRelations'
import type { SheetContext } from '../../workspace-sheets/sheetTypes'
import { createZustandSignal } from '../../infrastructure/state/solidStoreBridge.ts'

/**
 * FileContextPanel — file 右栏（W2-12，FE-AUD-022 反查）。
 *
 * 读取当前 FileSheet 的 activeFile（metadata），反查所有改动过它的会话
 * （path → sources，Windows 路径统一 normalize）；点击关联会话 → 返回
 * Agent Sheet 并选中该会话。不猜全局 activeSession。
 *
 * #515 贡献面翻转：Solid 实体。
 * props 形状 = ContextPanelContributionProps（contextPanelTypes 契约）。
 */
export default function FileContextPanel(props: { ctx: SheetContext }) {
  // 当前 FileSheet 的 activeFile（不猜全局 activeSession——报告 5D.2）
  const activeFile = createZustandSignal(useWorkspaceStore, state => {
    const fileSheets = state.workspaceSheets.sheets.filter(sheet => sheet.kind === 'file')
    const active = fileSheets.find(sheet => sheet.id === state.workspaceSheets.activeSheetId) ?? fileSheets[0]
    return active?.metadata?.activeFile ?? null
  })
  // 选整个 record（引用稳定），派生留组件体（Solid 组件体只跑一次，createMemo 承担派生）。
  const touchedFilesRecord = createZustandSignal(useWorkspaceStore, s => s.touchedFiles)
  const relatedSources = createMemo(() => activeFile() ? sourcesForPath(touchedFilesRecord(), activeFile()!) : [])
  const sessions = createZustandSignal(useIdentityStore, s => s.sessions)
  const activeAgent = createZustandSignal(useIdentityStore, s => s.activeAgent)

  return (
    <div class="context-panel-contribution">
      <div class="file-section-title">关联会话（{activeFile() ?? '无文件'}）</div>
      <Show when={activeFile()} fallback={<p class="file-section-hint">打开一个文件后显示改动过它的会话</p>}>
        <Show when={relatedSources().length > 0} fallback={<p class="file-section-hint">暂无会话改动此文件</p>}>
          <ul class="search-result-list">
            <For each={relatedSources()}>{source => {
              const session = () => sessions().find(item => item.source === source)
              return (
                <li>
                  <button
                    type="button"
                    class="search-result-row"
                    onClick={() => {
                      props.ctx.selectSession(session()?.id ?? null)
                      // owner 用会话自己的（不是当前 active Agent）——否则切过 Agent 后会把
                      // 别人的会话挂到当前 Agent 的 sheet 上（#326 审查顺带发现）。
                      props.ctx.openSheet({ kind: 'agent', title: session()?.name || source, agentId: session()?.agentId ?? activeAgent() })
                    }}
                  >
                    <span class="search-result-path">{source}</span>
                    <span class="search-result-text">{session()?.name ?? '外部会话'}</span>
                  </button>
                </li>
              )
            }}</For>
          </ul>
        </Show>
      </Show>
    </div>
  )
}
