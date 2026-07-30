import type { SheetInput, SheetRegistryEntry, SheetKind } from './sheetTypes.ts'

const singleton = (key: string) => (_input: Pick<SheetInput, 'agentId' | 'singletonKey' | 'metadata'>) => key
const agentSingleton = (input: Pick<SheetInput, 'agentId' | 'singletonKey' | 'metadata'>) => input.agentId ? `agent:${input.agentId}` : undefined

export const SHEET_REGISTRY: Record<SheetKind, SheetRegistryEntry> = {
  agent: { kind: 'agent', label: 'Agent', renderKey: 'agent-sheet', singleton: true, getSingletonKey: agentSingleton },
  prism: { kind: 'prism', label: 'Prism', renderKey: 'prism-manager-sheet', singleton: true, getSingletonKey: singleton('prism') },
  runtime: { kind: 'runtime', label: 'Runtime', renderKey: 'runtime-sheet', singleton: true, getSingletonKey: singleton('runtime') },
  file: { kind: 'file', label: 'File', renderKey: 'file-sheet', singleton: false, getSingletonKey: input => input.singletonKey },
  diff: { kind: 'diff', label: 'Diff', renderKey: 'diff-sheet', singleton: false, getSingletonKey: input => input.singletonKey },
  changes: { kind: 'changes', label: 'Changes', renderKey: 'changes-sheet', singleton: true, getSingletonKey: singleton('changes') },
  'git-history': { kind: 'git-history', label: 'Git History', renderKey: 'git-history-sheet', singleton: true, getSingletonKey: singleton('git-history') },
}

export function getSheetRegistryEntry(kind: unknown): SheetRegistryEntry | undefined {
  return typeof kind === 'string' && kind in SHEET_REGISTRY
    ? SHEET_REGISTRY[kind as SheetKind]
    : undefined
}

export function resolveSheetSingletonKey(input: Pick<SheetInput, 'kind' | 'agentId' | 'singletonKey' | 'metadata'>): string | undefined {
  return getSheetRegistryEntry(input.kind)?.getSingletonKey(input)
}
