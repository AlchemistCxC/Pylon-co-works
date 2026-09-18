interface ModeChangeOptions {
  source: string
  nextMode: string
  previousMode?: string
  writeMode: (mode: string) => void
  invokeSet: (source: string, mode: string) => Promise<unknown>
}

/** 切换循环顺序。与接受集分开：循环只服务 nextSessionMode 的轮换次序。 */
const MODE_CYCLE = ['default', 'accept_edit', 'auto', 'bypass'] as const
/**
 * 写入通道接受的 mode id 全集：循环内的四项 + agent 侧实际使用的等价词汇。
 * `accept_edits` / `dont_ask` 是 Hermes 认的 id（Pylon 不绑定单一 agent，接受并集）。
 * ★ 兜底候选表（workbenchOptionCatalog 的 DEFAULT_MODE_OPTIONS）里出现的每个 id
 *   都必须在本集合内，否则用户点了会报「无效的会话或权限模式」。
 */
const MODE_VALUES = [...MODE_CYCLE, 'accept_edits', 'dont_ask'] as const
const FALLBACK_MODE = 'default' as const

type SessionMode = typeof MODE_VALUES[number]

export function normalizeSessionMode(mode: string): SessionMode | null {
  const normalized = mode === 'edit' ? 'accept_edit' : mode
  return (MODE_VALUES as readonly string[]).includes(normalized)
    ? normalized as SessionMode
    : null
}

export function resolvePreviousSessionMode(previousMode?: string): SessionMode {
  return normalizeSessionMode(previousMode || '') || FALLBACK_MODE
}

export function nextSessionMode(currentMode: string): SessionMode {
  const normalized = normalizeSessionMode(currentMode) || FALLBACK_MODE
  const index = MODE_CYCLE.indexOf(normalized as typeof MODE_CYCLE[number])
  return MODE_CYCLE[(index + 1) % MODE_CYCLE.length]
}

export async function applySessionModeChange({
  source,
  nextMode,
  previousMode,
  writeMode,
  invokeSet,
}: ModeChangeOptions): Promise<void> {
  writeMode(nextMode)
  try {
    await invokeSet(source, nextMode)
  } catch (error) {
    writeMode(resolvePreviousSessionMode(previousMode))
    throw error
  }
}
