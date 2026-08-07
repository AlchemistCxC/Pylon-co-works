/**
 * browserClient — 浏览器域 typed client（报告阶段 4 / FE-AUD-008）。
 *
 * browser_set_bounds / browser_close 的 command/payload 收口。
 * browser_start 后端未提供（demo mock reject"待后端"），不猜契约——
 * 阶段 5C 按真实能力接线。
 */
import { ClientTransport } from '../acp/agentClient'

export function createBrowserClient(transport: ClientTransport) {
  return {
    status: (): Promise<unknown> => transport.invoke('browser_status'),
    start: (bounds: Record<string, unknown>): Promise<unknown> => transport.invoke('browser_start', { bounds }),
    navigate: (url: string): Promise<unknown> => transport.invoke('browser_navigate', { url }),
    back: (): Promise<unknown> => transport.invoke('browser_back'),
    forward: (): Promise<unknown> => transport.invoke('browser_forward'),
    reload: (): Promise<unknown> => transport.invoke('browser_reload'),
    setBounds: (bounds: Record<string, unknown>): Promise<unknown> => transport.invoke('browser_set_bounds', bounds),
    close: (): Promise<unknown> => transport.invoke('browser_close'),
  }
}

export type BrowserClient = ReturnType<typeof createBrowserClient>
