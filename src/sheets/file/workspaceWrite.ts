/**
 * workspaceWrite — write_workspace_text 前端收口（I08-A-FE-02，D-03/D-05）。
 *
 * workspaceContracts.ts 不在本卡 scope（只读引用）：conflict/too_large 两个新错误码
 * 在此本地分类，其余委托 classifyWorkspaceError。saveWorkspaceText 复用
 * normalizeWorkspaceText 收窄响应（损坏 DTO 返回 null 不崩）。
 */
import type { ClientTransport } from '../../infrastructure/acp/agentClient'
import { classifyWorkspaceError, normalizeWorkspaceText } from '../../infrastructure/tauri/workspaceContracts'
import type { WorkspaceTextPreview } from '../../components/right-panel/rightPanelTypes'

export interface SaveWorkspaceTextInput {
  source: string
  relativePath: string
  content: string
  expectedBaseline?: string | null
  force?: boolean
}

/** 保存错误码：conflict=外部修改；too_large=超 256KB 编辑上限；其余复用 workspace 分类 */
export type SaveErrorCode = 'conflict' | 'too_large' | 'not_found' | 'not_file' | 'io' | 'unknown'

export interface SaveErrorDetail {
  code: SaveErrorCode
  message: string
}

export function classifySaveError(error: unknown): SaveErrorDetail {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  if (/conflict/.test(normalized)) return { code: 'conflict', message }
  if (/too_large/.test(normalized)) return { code: 'too_large', message }
  const fallback = classifyWorkspaceError(error)
  const fallbackCode = fallback.code
  const code: SaveErrorCode = fallbackCode === 'not_found'
    ? 'not_found'
    : fallbackCode === 'not_file' || fallbackCode === 'not_a_file'
      ? 'not_file'
      : fallbackCode === 'io' || fallbackCode === 'io_error'
        ? 'io'
        : 'unknown'
  return { code, message: fallback.message }
}

export async function saveWorkspaceText(
  transport: ClientTransport,
  input: SaveWorkspaceTextInput,
): Promise<WorkspaceTextPreview | null> {
  const raw = await transport.invoke('write_workspace_text', {
    source: input.source,
    relativePath: input.relativePath,
    content: input.content,
    expectedBaseline: input.expectedBaseline ?? null,
    force: input.force ?? false,
  })
  return normalizeWorkspaceText(raw)
}
