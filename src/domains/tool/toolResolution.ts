import { listToolRegistryEntries, providersForTool, resolveToolRegistryEntry } from './toolRegistry.ts'
import { TOOL_KINDS, type ToolAction, type ToolKind, type ToolProvider, type ToolResolution } from './toolKinds.ts'

const ACTION_ALIASES: Array<[RegExp, ToolKind, ToolAction]> = [
  [/read|view|snapshot/, 'read', 'read'],
  [/write|create|replace/, 'edit', 'write'],
  [/edit|patch|apply|str_replace/, 'edit', 'edit'],
  [/grep|glob|search|find/, 'search', 'search'],
  [/bash|terminal|shell|exec|run|command|process/, 'execute', 'execute'],
  [/navigate/, 'fetch', 'navigate'],
  [/click/, 'execute', 'click'],
  [/type|fill|press|scroll|back/, 'execute', 'type'],
  [/fetch|extract|http|url|request|web/, 'fetch', 'fetch'],
  [/delegate|subagent|agent/, 'execute', 'delegate'],
  [/todo|plan|task/, 'other', 'plan'],
  [/skill/, 'read', 'skill'],
  [/think|reason/, 'think', 'unknown'],
]

function dictionaryKey(name: string): string {
  return name.trim().toLowerCase().replace(/^mcp__[^_]+__/, '')
}

function providerForName(name: string): ToolProvider {
  if (/^mcp__/.test(name.toLowerCase())) return 'mcp'
  return providersForTool(name)[0] as ToolProvider || 'unknown'
}

/**
 * 从 title 尾部（已按候选名截断）提取内嵌参数。
 * `Bash(npm run build)` → `npm run build`；`terminal: npm test` → `npm test`。
 * 成对括号会按深度剥到匹配的闭合，避免 `echo (hi)` 被错误截成 `echo (hi`。
 */
function extractEmbeddedSummary(tail: string): string {
  const trimmed = tail.trim()
  if (!trimmed) return ''
  const openBracket = trimmed[0] === '(' || trimmed[0] === '（' ? trimmed[0] : null
  if (openBracket) {
    const closeBracket = openBracket === '(' ? ')' : '）'
    let depth = 0
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i]
      if (ch === openBracket) depth += 1
      else if (ch === closeBracket) {
        depth -= 1
        if (depth === 0) return trimmed.slice(1, i).trim()
      }
    }
    return trimmed.slice(1).trim()
  }
  return trimmed.replace(/^[\s:：(（-]+/, '').replace(/[\s)）]+$/, '').trim()
}

/**
 * 通用标题解析：无注册表命中（fallback/alias）时也能从 title 拆出「工具名 / 参数」。
 * 只按括号或冒号边界拆分；纯空格不拆（多词工具名易误伤）。
 */
export function splitToolTitle(rawName: string): { name: string; summary: string } {
  const trimmed = (rawName ?? '').trim()
  if (!trimmed) return { name: '', summary: '' }

  const open = trimmed.indexOf('(')
  const openCjk = trimmed.indexOf('（')
  const bracketIdx = openCjk >= 0 && (open < 0 || openCjk < open) ? openCjk : open
  if (bracketIdx > 0) {
    const name = trimmed.slice(0, bracketIdx).trim()
    const openBracket = trimmed[bracketIdx]
    const closeBracket = openBracket === '(' ? ')' : '）'
    let depth = 0
    for (let i = bracketIdx; i < trimmed.length; i++) {
      const ch = trimmed[i]
      if (ch === openBracket) depth += 1
      else if (ch === closeBracket) {
        depth -= 1
        if (depth === 0) return { name, summary: trimmed.slice(bracketIdx + 1, i).trim() }
      }
    }
    return { name, summary: trimmed.slice(bracketIdx + 1).trim() }
  }

  const colon = trimmed.search(/[:\uFF1A]/)
  if (colon > 0) {
    return { name: trimmed.slice(0, colon).trim(), summary: trimmed.slice(colon + 1).trim() }
  }

  return { name: trimmed, summary: '' }
}

/** Peri/Hermes/MCP 工具名统一解析流水线：
 *  wire kind（权威） → provider 精确 → title 内嵌参数前缀 → 跨 provider 前缀 → alias 兜底 → fallback。
 *  前四步会尽量保留字典里的 displayName/summaryFields/outputLabel/embeddedSummary。 */
export function resolveToolType(
  name: string,
  wireKind?: string,
  context?: { provider?: string },
): ToolResolution {
  const rawName = name || 'unknown'
  let provider = (context?.provider ?? providerForName(rawName)) as ToolProvider

  let entry: ReturnType<typeof resolveToolRegistryEntry> = null
  let embeddedSummary: string | undefined

  if (provider === 'mcp') {
    entry = resolveToolRegistryEntry(provider, dictionaryKey(rawName))
  } else {
    if (provider !== 'unknown') entry = resolveToolRegistryEntry(provider, rawName)
    if (!entry) {
      const normalizedRaw = dictionaryKey(rawName)
      const candidates = provider !== 'unknown' ? listToolRegistryEntries(provider) : listToolRegistryEntries()
      outer: for (const candidate of candidates) {
        const names = [candidate.name, ...(candidate.aliases ?? [])]
        for (const candidateName of names) {
          const normalizedCandidate = candidateName.trim().toLowerCase()
          if (!normalizedCandidate || normalizedRaw === normalizedCandidate) continue
          if (
            normalizedRaw.startsWith(`${normalizedCandidate} `) ||
            normalizedRaw.startsWith(`${normalizedCandidate}:`) ||
            normalizedRaw.startsWith(`${normalizedCandidate}(`)
          ) {
            const trailing = extractEmbeddedSummary(rawName.slice(candidateName.length))
            if (trailing) {
              entry = candidate
              embeddedSummary = trailing
              provider = candidate.provider as ToolProvider
              break outer
            }
          }
        }
      }
    }
  }

  const normalizedWireKind = wireKind?.trim().toLowerCase()
  const wireKindValid = normalizedWireKind && TOOL_KINDS.includes(normalizedWireKind as ToolKind)
  if (wireKindValid) {
    return {
      kind: normalizedWireKind as ToolKind,
      action: normalizedWireKind as ToolAction,
      canonicalName: entry?.name ?? rawName,
      rawName,
      provider,
      matchedBy: 'wire',
      displayName: entry?.displayName,
      summaryFields: entry?.summaryFields,
      outputLabel: entry?.outputLabel,
      embeddedSummary,
    }
  }

  if (entry) {
    return {
      kind: entry.kind,
      action: entry.action,
      canonicalName: entry.name,
      rawName,
      provider,
      matchedBy: 'provider-dictionary',
      displayName: entry.displayName,
      summaryFields: entry.summaryFields,
      outputLabel: entry.outputLabel,
      embeddedSummary,
    }
  }

  const actionName = dictionaryKey(rawName)
  const alias = ACTION_ALIASES.find(([pattern]) => pattern.test(actionName))
  if (alias) {
    return { kind: alias[1], action: alias[2], canonicalName: rawName, rawName, provider, matchedBy: 'alias-dictionary' }
  }

  return { kind: 'other', action: 'unknown', canonicalName: rawName, rawName, provider, matchedBy: 'fallback' }
}

export function resolveToolKind(name: string, toolKind?: string): ToolKind {
  return resolveToolType(name, toolKind).kind
}
