import { useWorkspaceStore } from '../workspaceStore.ts'
import { openWorkspace } from '../workspace-sheets/workspaceController.ts'
import { normalizeSettingsSheetState } from '../workspace-sheets/settingsSheetState.ts'

/**
 * 设置 sheet 的打开 / 聚焦 / 深链导航统一入口（#154 阶段 4）。
 *
 * `pylon:open-settings` 事件、标题栏齿轮菜单、SheetLauncher 管理项全部汇到这里。
 * 旧覆盖层时代的两条通路（App 的 initialProps 首挂 + Settings 组件内的已挂载监听）
 * 收敛为一个「开则聚焦并 patch 状态、关则带状态打开」的幂等操作。
 * 归一口是 `normalizeSettingsSheetState`（内部走 `normalizeSettingsIntent`），
 * 深链别名与事件契约零迁移。
 */
export const SETTINGS_SHEET_KIND = 'settings'

/** 幂等打开设置 sheet 并落到目标 domain/section；已打开时不新开，只 patch 导航态并聚焦。 */
export function openOrFocusSettingsSheet(intent: { domain?: string; section?: string; agentId?: string } = {}): string | null {
  const normalized = normalizeSettingsSheetState(intent)
  const store = useWorkspaceStore.getState()
  const existing = store.workspaceSheets.sheets.find(sheet => sheet.kind === SETTINGS_SHEET_KIND)
  if (existing) {
    store.patchSheetState(existing.id, normalized as unknown as Record<string, unknown>)
    store.focusSheet(existing.id)
    return existing.id
  }
  return openWorkspace({ type: SETTINGS_SHEET_KIND, state: normalized })
}
