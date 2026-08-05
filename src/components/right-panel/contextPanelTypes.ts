/**
 * contextPanelTypes — ContextPanel 状态机（W1-04，F2-F）。
 *
 * 右栏两模式（搜索/关联）的判别联合 + transition（沿用现有 rightPanelTypes 的
 * 域化样板）：collapsed（折叠，来自 workspaceStore.rightPanelCollapsed）/ open 带 mode。
 * 纯 TS 可单测；模式切换状态合法由 focused 守卫锁定。
 */

export type ContextPanelMode = 'search' | 'relations'

export type ContextPanelState =
  | { status: 'collapsed' }
  | { status: 'open'; mode: ContextPanelMode }

export type ContextPanelEvent =
  | { type: 'open'; mode: ContextPanelMode }
  | { type: 'set-mode'; mode: ContextPanelMode }
  | { type: 'collapse' }

/** 默认折叠来自 workspaceStore.rightPanelCollapsed（W1-01 布局字段） */
export function createContextPanelState(collapsed: boolean): ContextPanelState {
  return collapsed ? { status: 'collapsed' } : { status: 'open', mode: 'search' }
}

export function transitionContextPanel(state: ContextPanelState, event: ContextPanelEvent): ContextPanelState {
  switch (event.type) {
    case 'open':
      return { status: 'open', mode: event.mode }
    case 'set-mode':
      // 折叠态不接受模式切换（无内容可切）
      return state.status === 'collapsed' ? state : { status: 'open', mode: event.mode }
    case 'collapse':
      return { status: 'collapsed' }
  }
}
