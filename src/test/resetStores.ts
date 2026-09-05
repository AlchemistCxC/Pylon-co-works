/**
 * resetStores — 测试间共享状态统一清理（阶段 0 测试夹具）。
 *
 * 清理范围：四个 Zustand store 回初始态（zustand v5 getInitialState）、
 * sessionUiState 注册表。测试 beforeEach/afterEach 调用。
 */

import { useStore } from '../store'
import { useIdentityStore } from '../identityStore'
import { useRuntimeStore } from '../runtimeStore'
import { useWorkspaceStore } from '../workspaceStore'
import { clearAllSessionUiState } from '../components/chat/sessionUiState'
import { usePresentationPreferenceStore } from '../domains/presentation/presentationPreferenceStore.ts'
import { useInterfaceModeStore } from '../domains/interface/interfaceModeStore.ts'
import { useWorkspaceEntityStore } from '../workspaceEntityStore.ts'
import { getRendererSettingsStore } from '../plugin-runtime/runtimeServices.ts'
import { useRightRailStore } from '../rightRailStore.ts'

export function resetStores(): void {
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true)
  // Persist middleware writes synchronously.  A test may intentionally leave
  // a quota-failing MemoryStorage installed after exercising the error path;
  // resetting in-memory state must still proceed and must not turn that
  // intentional fault into a cross-test failure.
  try {
    useRightRailStore.setState(useRightRailStore.getInitialState(), true)
  } catch {
    // The state update happens before persist's storage write.  Ignore only
    // the storage exception here; production actions retain their error path.
  }
  useIdentityStore.setState(useIdentityStore.getInitialState(), true)
  useRuntimeStore.setState(useRuntimeStore.getInitialState(), true)
  useStore.setState(useStore.getInitialState(), true)
  usePresentationPreferenceStore.setState(usePresentationPreferenceStore.getInitialState(), true)
  useInterfaceModeStore.setState(useInterfaceModeStore.getInitialState(), true)
  useWorkspaceEntityStore.setState(useWorkspaceEntityStore.getInitialState(), true)
  getRendererSettingsStore().setSessionPreview({})
  getRendererSettingsStore().reset()
  clearAllSessionUiState()
}
