/**
 * Agent 浏览器工具客户端（issue #82）。
 *
 * Rust 命令返回统一信封：`{ok:true, ...}` / `{ok:false, code, message}`。
 * 本客户端把拒绝信封转成带 `code` 的异常；`browser_agent_*` 命令不存在
 * （开发预览）时由 transport 层抛出原生错误。
 */

export interface AgentToolEnvelope {
  ok?: boolean
  code?: string
  message?: string
  [key: string]: unknown
}

export class BrowserAgentToolError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'BrowserAgentToolError'
    this.code = code
  }
}

export interface BrowserAgentSettingsView {
  schemaVersion?: number
  defaultMode?: 'off' | 'readonly' | 'full'
  workspaceModes?: Record<string, 'off' | 'readonly' | 'full'>
  domainBlocklist?: string[]
  adFilterEnabled?: boolean
}

export interface BrowserAgentOp {
  atMs?: number
  sessionKey?: string
  tool?: string
  summary?: string
  outcome?: string
}

export type BrowserAgentTransport = (command: string, args?: Record<string, unknown>) => Promise<unknown>

export function createBrowserAgentClient(transport: BrowserAgentTransport) {
  const call = async <T = AgentToolEnvelope>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const envelope = await transport(command, args) as AgentToolEnvelope
    if (envelope && envelope.ok === false) {
      throw new BrowserAgentToolError(String(envelope.code ?? 'error'), String(envelope.message ?? '浏览器工具调用失败'))
    }
    return envelope as T
  }

  return {
    getSettings: () => transport('browser_agent_get_settings') as Promise<BrowserAgentSettingsView>,
    setSettings: (settings: BrowserAgentSettingsView) => transport('browser_agent_set_settings', { settings }) as Promise<BrowserAgentSettingsView>,
    claimStatus: (workspaceId?: string | null) => transport('browser_agent_claim_status', { workspaceId: workspaceId ?? null }) as Promise<{ mode?: string; holder?: string | null }>,
    userActivity: () => transport('browser_agent_user_activity') as Promise<{ preempted?: string | null }>,
    recentOps: () => call<{ ops: BrowserAgentOp[] }>('browser_agent_recent_ops'),
    navigate: (input: { sessionKey?: string; workspaceId?: string; tabId?: number; url: string }) =>
      call('browser_agent_navigate', { ...input }),
    snapshot: (input: { sessionKey?: string; tabId?: number }) => call('browser_agent_snapshot', { ...input }),
    screenshot: (input: { sessionKey?: string; tabId?: number }) => call('browser_agent_screenshot', { ...input }),
    wait: (input: { sessionKey?: string; tabId?: number; until: string; selector?: string; timeoutMs?: number }) =>
      call('browser_agent_wait', { ...input }),
    readNetwork: (input: { sessionKey?: string; tabId?: number; limit?: number; requestId?: string }) =>
      call('browser_agent_read_network', { ...input }),
    savePage: (input: { sessionKey?: string; tabId?: number }) => call('browser_agent_save_page', { ...input }),
    scroll: (input: { sessionKey?: string; tabId?: number; deltaX?: number; deltaY?: number }) =>
      call('browser_agent_scroll', { ...input }),
    emulate: (input: { sessionKey?: string; tabId?: number; width?: number; height?: number; userAgent?: string; clear?: boolean }) =>
      call('browser_agent_emulate', { ...input }),
    tabList: () => call('browser_agent_tab_list'),
    tabNew: (input: { sessionKey?: string; workspaceId?: string; url?: string; background?: boolean }) =>
      call('browser_agent_tab_new', { ...input }),
    tabSelect: (input: { sessionKey?: string; workspaceId?: string; tabId: number }) =>
      call('browser_agent_tab_select', { ...input }),
    tabClose: (input: { sessionKey?: string; workspaceId?: string; tabId: number }) =>
      call('browser_agent_tab_close', { ...input }),
    click: (input: { sessionKey?: string; workspaceId?: string; tabId?: number; ref?: string; selector?: string }) =>
      call('browser_agent_click', { ...input }),
    type: (input: { sessionKey?: string; workspaceId?: string; tabId?: number; text: string; ref?: string; selector?: string; submit?: boolean }) =>
      call('browser_agent_type', { ...input }),
    press: (input: { sessionKey?: string; workspaceId?: string; tabId?: number; key: string }) =>
      call('browser_agent_press', { ...input }),
    download: (input: { sessionKey?: string; workspaceId?: string; tabId?: number; url: string; filename?: string }) =>
      call('browser_agent_download', { ...input }),
  }
}

export type BrowserAgentClient = ReturnType<typeof createBrowserAgentClient>
