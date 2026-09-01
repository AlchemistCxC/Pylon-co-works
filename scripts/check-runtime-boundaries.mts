/**
 * B-04 runtime boundary guardrail.
 *
 * Existing direct Tauri/store imports are deliberately a report-only legacy
 * inventory.  A new path must be added to an explicit allowlist (and therefore
 * reviewed) before the checker can pass.  CustomEvent names are stricter: a
 * pylon DOM event must be present in the typed registry.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceExtensions = new Set(['.ts', '.tsx', '.mts'])
const productionFile = (path: string): boolean =>
  !path.includes('/__tests__/')
  && !path.includes('/test/')
  && !path.endsWith('.test.ts')
  && !path.endsWith('.test.tsx')
  && !path.endsWith('.test.mts')

/** Existing production paths; additions require an explicit review entry. */
export const DIRECT_INVOKE_ALLOWLIST = new Set([
  'src/App.tsx',
  'src/application/transactions/openOwnedSessionTransaction.ts',
  'src/cli/pylonCliBridge.ts',
  'src/cli/pylonCliDomainPorts.ts',
  'src/components/chat/chatEventController.ts',
  'src/components/chat/InputBar.tsx',
  'src/components/chat/ModeWidget.tsx',
  'src/components/chat/sessionMode.ts',
  'src/components/chat/sessionModel.ts',
  'src/components/chat/streamingSend.ts',
  'src/components/chat/useSessionLifecycle.ts',
  'src/components/PetCompanion.tsx',
  'src/components/SessionSettings.tsx',
  'src/components/Settings.tsx',
  'src/components/settings/AgentConfigEditor.tsx',
  'src/components/settings/AgentRuntimePanel.tsx',
  'src/components/settings/ConfigOptionsPanel.tsx',
  'src/components/settings/CwdSettingsPanel.tsx',
  'src/components/settings/GatewayRiskPanel.tsx',
  'src/components/Sidebar.tsx',
  'src/infrastructure/events/canonicalEventRepository.ts',
  'src/infrastructure/skin/skinHostPorts.ts',
  'src/obs04/devTrigger.ts',
  'src/plugin-runtime/pluginCompositionRoot.ts',
  'src/plugin-runtime/process/processRuntimeServices.ts',
  'src/plugins/core/browser/builtinBrowserCommands.ts',
  'src/plugins/core/commandSet/builtinCommandExecutors.ts',
  'src/plugins/core/file/builtinFileWorkbench.ts',
  'src/retentionPolicyRepository.ts',
  'src/sheets/agent-workbench/agentWorkbenchCommands.ts',
  'src/sheets/agent-workbench/agentWorkbenchSessionCreation.ts',
  'src/sheets/browser/BrowserSheetView.tsx',
  'src/sheets/file/DispatchBar.tsx',
  'src/sheets/file/legacyFileProvider.ts',
  'src/sheets/gateway/GatewaySheetView.tsx',
  'src/sheets/history/HistorySheetView.tsx',
  'src/sheets/OverviewSheetView.tsx',
  'src/sheets/RuntimeSheetView.tsx',
  'src/userDataRepository.ts',
  'src/workspaceEntityStore.ts',
  'src/workspace-sheets/activateAgentSheet.ts',
])

/** Solid/plugin legacy imports; these are the next migration inventory. */
export const GLOBAL_STORE_ALLOWLIST = new Set([
  'src/plugins/core/browser/builtinBrowserCommands.ts',
  'src/plugins/core/commandSet/builtinCommandExecutors.ts',
  'src/plugins/core/file/builtinFileCommands.ts',
  'src/plugins/core/renderer/builtinPresentationCommands.ts',
  'src/plugins/core/sessionCreation/sessionPreflight.ts',
  'src/plugins/core/sessionState/runtimeStoreSessionState.ts',
  'src/plugins/core/sheet/builtinWorkspaceCommands.ts',
  'src/plugins/core/shell/builtinShellCommands.ts',
  'src/plugins/product/builtinPylonAgentAdapters.ts',
  'src/renderers/solid-workbench/input/ControlCenter.solid.tsx',
])

async function walk(directory: string): Promise<string[]> {
  let entries
  try { entries = await readdir(directory) } catch { return [] }
  const output: string[] = []
  for (const name of entries) {
    const path = resolve(directory, name)
    const info = await stat(path)
    if (info.isDirectory()) output.push(...await walk(path))
    else output.push(path)
  }
  return output
}

function displayPath(path: string): string {
  return relative(projectRoot, path).replaceAll('\\', '/')
}

function importSpecifiers(source: string): string[] {
  const values: string[] = []
  for (const match of source.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g)) values.push(match[1])
  for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) values.push(match[1])
  return values
}

function hasDirectInvoke(source: string): boolean {
  if (!source.includes('@tauri-apps/api/core')) return false
  // Match both static `{ invoke }` imports and dynamic import() wrappers used
  // by browser/portable fallbacks.  Type-only Channel imports do not match.
  return /\b(?:import|export)\s*\{[^}]*\binvoke\b[^}]*\}\s*from\s*['"]@tauri-apps\/api\/core['"]/.test(source)
    || (/\bimport\s*\(\s*['"]@tauri-apps\/api\/core['"]\s*\)/.test(source) && /\binvoke\b/.test(source))
}

function hasGlobalStoreImport(path: string, source: string): boolean {
  if (!path.startsWith('src/plugins/') && !path.startsWith('src/renderers/solid-workbench/')) return false
  for (const line of source.split('\n')) {
    const specifier = line.match(/\bfrom\s*['"]([^'"]+)['"]/)?.[1]
    if (!specifier) continue
    const basename = specifier.split('/').at(-1)?.replace(/\.tsx?$/, '')
    if (basename && ['store', 'identityStore', 'runtimeStore', 'workspaceStore', 'workspaceEntityStore'].includes(basename)) return true
  }
  return false
}

function customEventNames(source: string): string[] {
  const names: string[] = []
  const patterns = [
    /\bnew\s+CustomEvent(?:<[^>]*>)?\s*\(\s*['"](pylon:[^'"]+)['"]/g,
    /\.(?:add|remove)EventListener\s*\(\s*['"](pylon:[^'"]+)['"]/g,
  ]
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) names.push(match[1])
  return names
}

async function registryNames(): Promise<Set<string>> {
  const path = resolve(projectRoot, 'src/domains/events/pylonCustomEvents.ts')
  const source = await readFile(path, 'utf8')
  return new Set([...source.matchAll(/['"](pylon:[^'"]+)['"]/g)].map(match => match[1]))
}

export async function runRuntimeBoundaryCheck(): Promise<{ violations: string[]; reports: string[] }> {
  const violations: string[] = []
  const reports: string[] = []
  const registry = await registryNames()
  for (const file of await walk(resolve(projectRoot, 'src'))) {
    if (!sourceExtensions.has(extname(file))) continue
    const path = displayPath(file)
    if (!productionFile(`/${path}`)) continue
    const source = await readFile(file, 'utf8')

    if (hasDirectInvoke(source)) {
      if (DIRECT_INVOKE_ALLOWLIST.has(path)) reports.push(`${path}: direct invoke（legacy allowlist，仅报告）`)
      else violations.push(`${path}: direct invoke 未登记 allowlist`)
    }
    if (hasGlobalStoreImport(path, source)) {
      if (GLOBAL_STORE_ALLOWLIST.has(path)) reports.push(`${path}: global store import（legacy allowlist，仅报告）`)
      else violations.push(`${path}: global store import 未登记 allowlist`)
    }
    for (const name of customEventNames(source)) {
      if (!registry.has(name)) violations.push(`${path}: CustomEvent ${name} 未登记 typed registry`)
    }
  }
  return { violations, reports }
}

const result = await runRuntimeBoundaryCheck()
for (const report of result.reports) console.warn(`边界遗留：${report}`)
if (result.violations.length > 0) {
  console.error(`运行时边界门禁失败：\n${result.violations.map(item => `- ${item}`).join('\n')}`)
  process.exit(1)
}
console.log(`运行时边界门禁通过：${result.reports.length} 条遗留白名单仅报告；无新增 invoke/store/CustomEvent 越界`)
