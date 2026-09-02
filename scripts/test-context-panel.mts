/**
 * STRUCTURE GUARD（结构守卫）：右栏贡献 Host/Registry 接线。
 * 行为证据见 ContextPanelHost.test.tsx 与 contextPanelRegistry.test.ts。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const host = readFileSync(new URL('../src/components/right-panel/ContextPanelHost.tsx', import.meta.url), 'utf8')
const slot = readFileSync(new URL('../src/components/right-panel/RightRailHost.tsx', import.meta.url), 'utf8')
const productWorkspace = readFileSync(new URL('../src/plugins/product/builtinPylonWorkspace.ts', import.meta.url), 'utf8')
const activation = readFileSync(new URL('../src/plugin-runtime/pluginActivationContext.ts', import.meta.url), 'utf8')
const shadow = readFileSync(new URL('../src/plugin-runtime/shadowUpdate.ts', import.meta.url), 'utf8')

assert.match(slot, /useRightRailStore\(state => state\.collapsed\)/, '全局右栏宿主必须读统一折叠状态')
assert.match(slot, /if \(entries\.length === 0\) return null/, '无贡献时不得挂载')
assert.match(slot, /right-rail-host\$\{collapsed/, '折叠状态必须由右栏外壳承担，以支持宽度/透明度动画')
assert.match(slot, /data-collapsed=\{collapsed \? 'true' : 'false'\}/, '右栏外壳必须暴露折叠状态')
assert.match(slot, /<ContextPanelHost sheet=\{activeSheet\} ctx=\{ctx\} activePanelId=\{effectivePanelId\} \/>/, '宿主必须挂统一贡献 Host')
assert.match(host, /role="tablist"/, '多贡献必须以可访问标签切换')
assert.match(host, /PluginContributionBoundary/, '每个右栏贡献必须有独立错误边界')
assert.match(host, /renderKind === 'isolated-surface'/, '外置 UI 必须走隔离 surface')
assert.match(host, /event === 'host:collapse'/, '隔离 surface 只能通过受控事件请求宿主动作')
assert.match(productWorkspace, /workspaceKind: 'agent'/, 'Agent 右栏必须注册贡献')
assert.match(productWorkspace, /workspaceKind: 'file'/, 'File 右栏必须注册贡献')
assert.match(activation, /contextPanel: createPluginContextPanelApi/, '激活上下文必须暴露右栏贡献 API')
assert.match(shadow, /contextPanel: registries\.contextPanelRegistry\.beginShadowTransaction/, '右栏贡献必须参与 shadow hot-swap')

const agentPanel = readFileSync(new URL('../src/components/right-panel/AgentContextPanel.tsx', import.meta.url), 'utf8')
assert.match(agentPanel, /useSessionUiState\(sessionId, 'search-query'/, 'Agent 搜索必须复用 sessionUiState')
assert.match(agentPanel, /getChatController\(\)\?\.getMessages\(source\)/, '消息快照必须经 handle.getMessages')
assert.match(agentPanel, /useWorkspaceStore\(s => s\.touchedFiles\)/, 'Agent 关联必须读 touchedFiles')
assert.match(agentPanel, /touchedFilesRecord\[toAgentContextKey\(touchedContext\)\]/, 'Agent 关联必须使用 context key')
assert.match(agentPanel, /import MessageSearchBar/, 'Agent 搜索必须复用 MessageSearchBar')
const filePanel = readFileSync(new URL('../src/components/right-panel/FileContextPanel.tsx', import.meta.url), 'utf8')
assert.match(filePanel, /useWorkspaceStore\(s => s\.touchedFiles\)/, 'File 右栏必须反查 touchedFiles')

console.log('context panel 贡献宿主守卫通过')
