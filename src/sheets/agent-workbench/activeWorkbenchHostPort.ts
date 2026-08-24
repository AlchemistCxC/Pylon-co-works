import type { WorkbenchHostPort } from '../../renderers/solid-workbench/workbenchHostPort.ts'

const activePorts = new Map<string, WorkbenchHostPort>()
const listeners = new Map<string, Set<() => void>>()

function notify(sheetId: string): void {
  for (const listener of [...(listeners.get(sheetId) ?? [])]) listener()
}

/** Sheet-scoped read-only discovery seam for sibling UI such as the right panel. */
export function getActiveWorkbenchHostPort(sheetId: string): WorkbenchHostPort | undefined {
  return activePorts.get(sheetId)
}

export function subscribeActiveWorkbenchHostPort(sheetId: string, listener: () => void): () => void {
  const current = listeners.get(sheetId) ?? new Set<() => void>()
  current.add(listener)
  listeners.set(sheetId, current)
  return () => {
    current.delete(listener)
    if (current.size === 0) listeners.delete(sheetId)
  }
}

export function publishActiveWorkbenchHostPort(sheetId: string, hostPort: WorkbenchHostPort): () => void {
  if (activePorts.get(sheetId) !== hostPort) {
    activePorts.set(sheetId, hostPort)
    notify(sheetId)
  }
  return () => {
    if (activePorts.get(sheetId) !== hostPort) return
    activePorts.delete(sheetId)
    notify(sheetId)
  }
}
