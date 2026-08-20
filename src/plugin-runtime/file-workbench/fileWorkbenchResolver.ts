import type { WorkspaceTarget } from '../../domains/workspace/workspaceTarget.ts'
import { fileTabViewType, type FileTabRecord } from '../../sheets/file/fileSheetState.ts'
import { getFileWorkbenchRegistry } from '../runtimeServices.ts'
import type { FileActivityContribution, FileProvider, FileViewRendererDefinition, GitProvider } from './fileWorkbenchTypes.ts'

export function listFileActivities(target: WorkspaceTarget | null): readonly FileActivityContribution[] {
  return getFileWorkbenchRegistry().getSnapshot().entries.map(entry => entry.value)
    .filter((value): value is FileActivityContribution => value.kind === 'activity' && (!value.when || value.when(target)))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}
export function resolveFileProvider(target: WorkspaceTarget | null): FileProvider | null {
  if (!target) return null
  const providers = getFileWorkbenchRegistry().getSnapshot().entries.map(entry => entry.value)
    .filter((value): value is Extract<typeof value, { kind: 'file-provider' }> => value.kind === 'file-provider')
    .filter(value => value.provider.canHandle(target))
  return providers.sort((a, b) => a.priority - b.priority)[0]?.provider ?? null
}
export function resolveGitProvider(target: WorkspaceTarget | null): GitProvider | null {
  if (!target) return null
  const providers = getFileWorkbenchRegistry().getSnapshot().entries.map(entry => entry.value)
    .filter((value): value is Extract<typeof value, { kind: 'git-provider' }> => value.kind === 'git-provider')
    .filter(value => value.provider.canHandle(target) === true)
  return providers.sort((a, b) => a.priority - b.priority)[0]?.provider ?? null
}
export function resolveFileViewRenderer(target: WorkspaceTarget | null, tab: FileTabRecord | null, excludedIds: ReadonlySet<string> = new Set()): FileViewRendererDefinition | null {
  if (!target || !tab) return null
  const renderers = getFileWorkbenchRegistry().getSnapshot().entries.map(entry => entry.value)
    .filter((value): value is FileViewRendererDefinition => value.kind === 'renderer')
    .filter(value => !excludedIds.has(value.id))
    .sort((a, b) => a.priority - b.priority)
  return renderers.find(renderer => renderer.canRender({ target, tab }))
    ?? renderers.find(renderer => renderer.fallback && fileTabViewType(tab).startsWith('file.'))
    ?? null
}
