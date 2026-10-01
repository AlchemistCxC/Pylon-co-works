import { useSyncExternalStore } from 'react'
import { DEFAULT_INTERFACE_MODE, useInterfaceModeStore } from '../domains/interface/interfaceModeStore.ts'
import type { InterfaceModeContribution } from '../plugin-runtime/interface-mode/interfaceModeTypes.ts'
import { getInterfaceModeRegistry } from '../plugin-runtime/runtimeServices.ts'
import { findInterfaceModeContribution } from './interfaceModeLookup.ts'

const interfaceModeRegistry = getInterfaceModeRegistry()
const subscribeInterfaceModes = (listener: () => void) => interfaceModeRegistry.subscribe(listener)
const getInterfaceModeSnapshot = () => interfaceModeRegistry.getSnapshot()

/**
 * 当前激活界面模式的 contribution（registry 真值；registry 尚未填充/测试环境下
 * 依序回退：内置模式表按激活 id 匹配 → DEFAULT_INTERFACE_MODE 兜底）。
 * 视图层按声明位（sceneSurface/shellSurface/chromeStyle/capabilities）渲染，
 * 不对模式 id 做字符串特判（A-V9）。
 */
export function useActiveInterfaceModeContribution(): InterfaceModeContribution {
  const interfaceMode = useInterfaceModeStore(state => state.interfaceMode)
  const snapshot = useSyncExternalStore(subscribeInterfaceModes, getInterfaceModeSnapshot, getInterfaceModeSnapshot)
  return snapshot.entries.find(entry => entry.value.id === interfaceMode)?.value
    ?? findInterfaceModeContribution(interfaceMode)
    ?? findInterfaceModeContribution(DEFAULT_INTERFACE_MODE)!
}
