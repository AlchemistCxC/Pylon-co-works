import type { SheetId } from './sheetTypes.ts'

type WorkspaceLiveCloseGuard = () => boolean | Promise<boolean>

const guards = new Map<SheetId, WorkspaceLiveCloseGuard>()

/**
 * Registers a close decision backed by live, non-serializable UI state such as
 * an editor draft. Workspace definition codecs cannot represent that state.
 */
export function registerWorkspaceLiveCloseGuard(id: SheetId, guard: WorkspaceLiveCloseGuard): () => void {
  guards.set(id, guard)
  return () => {
    if (guards.get(id) === guard) guards.delete(id)
  }
}

export async function canCloseWorkspaceLiveState(id: SheetId): Promise<boolean> {
  const guard = guards.get(id)
  if (!guard) return true
  try {
    return await guard()
  } catch {
    return false
  }
}
