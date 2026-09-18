/** Framework-neutral preset payload; product layers may refine this shape. */
export type PresetPayload = Readonly<Record<string, unknown>>

export interface PresetContribution {
  /** 全局唯一 */
  readonly id: string
  readonly label: string
  /** 归属标记（如界面模式 id）；框架中立，不枚举 */
  readonly scope?: string
  readonly payload: PresetPayload
}

export interface ResolvedPreset extends PresetContribution {
  readonly ownerPluginId: string
  readonly ownerRuntimeInstanceId: string
  readonly contributionId: string
}
