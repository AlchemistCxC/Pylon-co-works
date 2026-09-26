/**
 * identityCrossDomainWiring — 应用装配层把 identity 联动端口绑定到 workspace/runtime
 * 域 store（#351）。各委托体与断链前的 `identityStore` 直连调用逐字一致；同步性由
 * 端口契约（`app/ports/identityCrossDomainPort`）保持。生产在 App.tsx 以 side-effect
 * import 装配（先于 hydrate 与任何 identity mutation）；测试经 `src/test/resetStores`
 * 获得同一装配。
 */
import { useRuntimeStore } from '../../domains/runtime/runtimeStore'
import { useWorkspaceStore } from '../../domains/workspace/workspaceStore'
import { registerIdentityCrossDomainPort } from '../ports/identityCrossDomainPort'

registerIdentityCrossDomainPort({
  sheetAgentStates: () => useWorkspaceStore.getState().sheetAgentStates,
  patchSheetAgentState: (agentId, patch) => useWorkspaceStore.getState().patchSheetAgentState(agentId, patch),
  patchSheetAgentStates: states => useWorkspaceStore.getState().patchSheetAgentStates(states),
  pruneAgentSheets: agentIds => useWorkspaceStore.getState().pruneAgentSheets(agentIds),
  clearSessionSource: context => useRuntimeStore.getState().clearSessionSource(context),
})
