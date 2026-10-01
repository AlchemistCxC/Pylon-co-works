import type { InterfaceModeContribution } from '../plugin-runtime/interface-mode/interfaceModeTypes.ts'
import { BUILTIN_INTERFACE_MODES } from '../plugins/core/interfaceMode/builtinInterfaceModes.ts'
import { getInterfaceModeRegistry } from '../plugin-runtime/runtimeServices.ts'

/**
 * Interface Mode 贡献的唯一查询缝（#485 划线）。
 *
 * registry 真值优先；registry 未填充（bootstrap 早期/测试环境直接挂载组件）时
 * 回退 builtin 表。builtin 表是产品层 registerMode 的源数据——视图层不得直连
 * `plugins/core/*`（product-contribution guard 按划线管辖），builtin 引用只允许
 * 住在本缝与 `useActiveInterfaceModeContribution` 这类 app 层连接件里。
 */
export function findInterfaceModeContribution(modeId: string): InterfaceModeContribution | undefined {
  return getInterfaceModeRegistry().resolve(modeId)?.value
    ?? BUILTIN_INTERFACE_MODES.find(contribution => contribution.id === modeId)
}
