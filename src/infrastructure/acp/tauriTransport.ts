/**
 * tauriInvokeTransport — ClientTransport 的默认 Tauri 实现。
 *
 * 收口此前散布在各 UI 文件的内联适配器（`invoke: (cmd, args) => invoke(cmd, args as …)`）；
 * transport 仍可注入，测试不依赖真实 Tauri（见 agentClient.ts 的 ClientTransport）。
 */
import { invoke } from '@tauri-apps/api/core'

export function tauriInvokeTransport(cmd: string, args?: unknown): Promise<unknown> {
  return invoke(cmd, args as Record<string, unknown> | undefined)
}
