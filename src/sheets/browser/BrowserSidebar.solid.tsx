/** @jsxImportSource solid-js */
import { For } from 'solid-js'
import { LucideIcon } from '../../components/LucideIcon.solid.tsx'
import { BROWSER_PHASE_LABELS, type BrowserSnapshot, type BrowserToolId } from './browserSheetTypes.ts'

// Browser library tools are backed by the local library + explicit host commands.
const TOOL_ITEMS = [
  { id: 'agent', label: 'Agent', icon: 'Bot' },
  { id: 'history', label: '历史', icon: 'Clock3' },
  { id: 'bookmarks', label: '书签', icon: 'Bookmark' },
  { id: 'downloads', label: '下载', icon: 'Download' },
  { id: 'console', label: '控制台', icon: 'Code2' },
] as const

/** 左列工具导航（#228 批次 D 从 BrowserSheetView.tsx 纯搬移；props 由主组件传入）。 */
// #515 批7：React → Solid 实体（BrowserSheetView.solid 直连）；DOM 逐字节保持。
export function BrowserSidebar(props: { sidebarCollapsed: boolean; activeTool: BrowserToolId | null; onSelectTool: (tool: BrowserToolId) => void; phase: BrowserSnapshot['phase'] }) {
  return (
    // #154：左列几何归布局层的 .sidebar。原先这里是硬编码 156px / 折叠 42px，
    // 标题栏轨道却是 240px——实测两条分割线错开 84px，正是用户报的「浏览器
    // Sheet 分割线对不齐」。内部仍在折叠态适配的类（justify-center 等）保留，
    // 它们只影响内容排布，不再影响宽度。
    <aside class="sidebar browser-sidebar flex min-h-0 flex-col bg-[color-mix(in_srgb,var(--bg-panel)_82%,transparent)]">
      <div class={`browser-sidebar-head min-h-[36px] flex items-center px-3 border-b border-border max-[720px]:justify-center max-[720px]:px-0 ${props.sidebarCollapsed ? 'justify-center px-0' : ''}`}>
        {!props.sidebarCollapsed && <span class="browser-sidebar-title text-text-dim font-bold text-[10px] font-[family-name:var(--mono)] tracking-[.12em] max-[720px]:hidden">TOOLS</span>}
      </div>
      <nav class="browser-tool-list flex flex-col gap-[2px] py-2 px-1.5 max-[720px]:px-[5px]" aria-label="浏览器工具栏">
        <For each={TOOL_ITEMS}>
          {item => (
            <button
              type="button"
              class={`browser-tool-item flex min-h-[34px] items-center gap-2 px-2 border border-transparent rounded-[4px] text-left cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent max-[720px]:justify-center max-[720px]:px-0 ${props.sidebarCollapsed ? 'justify-center px-0' : ''} ${props.activeTool === item.id ? 'border-[color-mix(in_srgb,var(--accent)_45%,var(--border))] text-text bg-bg-active' : 'border-transparent text-text-dim bg-transparent hover:text-text hover:bg-bg-hover'}`}
              onClick={() => props.onSelectTool(item.id)}
              title={item.label}
              aria-label={item.label}
              aria-pressed={props.activeTool === item.id}
            >
              <LucideIcon name={item.icon} size={18} aria-hidden="true" />
              {!props.sidebarCollapsed && <span class="text-[12px] max-[720px]:hidden">{item.label}</span>}
            </button>
          )}
        </For>
      </nav>
      {!props.sidebarCollapsed && <div class={`browser-sidebar-note mt-auto py-2.5 px-3 text-text-placeholder font-[family-name:var(--mono)] text-[10px] leading-[1.5] max-[720px]:hidden ${props.sidebarCollapsed ? 'hidden' : ''}`}>WebView 会话<br /><span class="text-text-dim">{BROWSER_PHASE_LABELS[props.phase]}</span></div>}
    </aside>
  )
}
