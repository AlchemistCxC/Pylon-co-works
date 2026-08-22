/**
 * resetStores — 测试间共享状态统一清理（阶段 0 测试夹具）。
 *
 * 清理范围：四个 Zustand store 回初始态（zustand v5 getInitialState）、
 * chatEventController 单例、sessionUiState 注册表。测试 beforeEach/afterEach 调用。
 */

import { useStore } from '../store'
import { useIdentityStore } from '../identityStore'
import { useRuntimeStore } from '../runtimeStore'
import { useWorkspaceStore } from '../workspaceStore'
import { registerChatController } from '../components/chat/chatEventController'
import { clearAllSessionUiState } from '../components/chat/sessionUiState'
import { usePresentationPreferenceStore } from '../domains/presentation/presentationPreferenceStore.ts'
import { useInterfaceModeStore } from '../domains/interface/interfaceModeStore.ts'
import { useWorkspaceEntityStore } from '../workspaceEntityStore.ts'
import { getRendererSettingsStore } from '../plugin-runtime/runtimeServices.ts'

export function resetStores(): void {
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true)
  useIdentityStore.setState(useIdentityStore.getInitialState(), true)
  useRuntimeStore.setState(useRuntimeStore.getInitialState(), true)
  useStore.setState(useStore.getInitialState(), true)
  usePresentationPreferenceStore.setState(usePresentationPreferenceStore.getInitialState(), true)
  useInterfaceModeStore.setState(useInterfaceModeStore.getInitialState(), true)
  useWorkspaceEntityStore.setState(useWorkspaceEntityStore.getInitialState(), true)
  getRendererSettingsStore().setSessionPreview({})
  getRendererSettingsStore().reset()
  registerChatController(null)
  clearAllSessionUiState()
}
