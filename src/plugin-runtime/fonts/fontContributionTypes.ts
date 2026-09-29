import type { FontContribution } from '../../contracts/fonts.ts'
import type { RegistryEntry } from '../registry/types.ts'

// 契约正身在 src/contracts/fonts.ts（中立落点，domains/theme 与本层共用；
// 结构审查 B-5：消除 theme⇄plugin-runtime 类型环）。此文件保留注册表包装类型。
export type { FontContribution, FontRole } from '../../contracts/fonts.ts'

export type FontContributionRegistryEntry = RegistryEntry<FontContribution>
