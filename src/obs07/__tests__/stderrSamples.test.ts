/**
 * OBS-07：P5 stderr 真实样本与"监控窗口"识别取证工具单元测试。
 *
 * 覆盖：分类（tracing 型 / hub 型 / fixed-title 型 / none——LOG-04 起分流 POST-LOG-01
 * 生产形态 hub=source=agent-stderr+真实行文本 与历史形态 A/B 型）；每 agent 统计（A/B/hub
 * 计数、ratio=fixedTitle/(tracing+hub)、correlationPresent、codeCarrying、levels 等级分布、
 * 样本脱敏 + 上限、指纹聚合）；P5 判定（窗口证据、双重写、correlationDroppedFrontend
 * 结构性常量——LOG-03 起为 false、样本可用）；工件组装与脱敏（secret 值 REDACTED、绝对路径收窄）。
 */

import { describe, expect, it } from 'vitest'
import {
  buildP5Checks,
  buildStderrSamplesArtifact,
  classifyStderrEntry,
  collectStderrSamples,
  MAX_FINGERPRINTS_PER_AGENT,
  MAX_SAMPLES_PER_AGENT,
  narrowEmbeddedPaths,
  RUNTIME_WINDOW_EVIDENCE,
  type StderrWireEntry,
} from '../stderrSamples'

const tracingEntry = (agent: string, line: string, overrides: Partial<StderrWireEntry> = {}): StderrWireEntry => ({
  source: 'prism_desktop::acp::transport',
  level: 'error',
  message: `${agent} stderr: ${line}`,
  timestamp: 1000,
  ...overrides,
})

const fixedTitleEntry = (agent: string, overrides: Partial<StderrWireEntry> = {}): StderrWireEntry => ({
  source: 'agent-stderr',
  level: 'error',
  message: 'Agent stderr output',
  fields: { agent },
  correlation: { agent_id: agent, source: `local:s1`, peri_id: 'perm-9' },
  timestamp: 1000,
  ...overrides,
})

/** POST-LOG-01 hub 生产形态：source=agent-stderr + 真实行文本 + LOG-03 增量字段。 */
const hubEntry = (agent: string, line: string, overrides: Partial<StderrWireEntry> = {}): StderrWireEntry => ({
  source: 'agent-stderr',
  level: 'info',
  message: line,
  fields: { agent },
  correlation: { agent_id: agent, source: `local:s1`, peri_id: 'perm-9' },
  code: 'agent_error',
  category: 'stderr',
  rawAvailable: true,
  timestamp: 1000,
  ...overrides,
})

const unrelatedEntry = (message = 'connect ok', overrides: Partial<StderrWireEntry> = {}): StderrWireEntry => ({
  source: 'prism_desktop::acp::transport',
  level: 'info',
  message,
  ...overrides,
})

// ── 分类 ────────────────────────────────────────────────────────────────────

describe('classifyStderrEntry', () => {
  it('tracing 型："{agent} stderr: {line}" → agent + 真实行文本', () => {
    expect(classifyStderrEntry(tracingEntry('peri', 'panic: nil index'))).toEqual({
      kind: 'tracing', agent: 'peri', line: 'panic: nil index',
    })
  })

  it('fixed-title 型：source=agent-stderr → agent 取自 fields.agent；correlation 保留在 wire', () => {
    const entry = fixedTitleEntry('hermes')
    expect(classifyStderrEntry(entry)).toEqual({ kind: 'fixed-title', agent: 'hermes', line: null })
    expect(entry.correlation).toMatchObject({ agent_id: 'hermes', peri_id: 'perm-9' })
  })

  it('fixed-title 但 fields.agent 缺失 → agent=null（不计入任何 agent 统计）', () => {
    expect(classifyStderrEntry({ source: 'agent-stderr', message: 'Agent stderr output', fields: null }))
      .toEqual({ kind: 'fixed-title', agent: null, line: null })
  })

  it('hub 型（LOG-04）：source=agent-stderr + 真实行文本 → kind=hub + line=message（POST-LOG-01 生产形态）', () => {
    expect(classifyStderrEntry(hubEntry('peri', 'panic: nil index')))
      .toEqual({ kind: 'hub', agent: 'peri', line: 'panic: nil index' })
    expect(classifyStderrEntry(hubEntry('hermes', 'segmentation fault')))
      .toEqual({ kind: 'hub', agent: 'hermes', line: 'segmentation fault' })
  })

  it('hub 型但 fields.agent 缺失 → agent=null（不计入任何 agent 统计）', () => {
    expect(classifyStderrEntry({ source: 'agent-stderr', message: 'real line', fields: null }))
      .toEqual({ kind: 'hub', agent: null, line: 'real line' })
  })

  it('source=agent-stderr 分流：占位符 → fixed-title，真实文本 → hub（同一 source 两形态）', () => {
    expect(classifyStderrEntry(fixedTitleEntry('peri'))).toEqual({ kind: 'fixed-title', agent: 'peri', line: null })
    expect(classifyStderrEntry(hubEntry('peri', 'real stderr text'))).toEqual({ kind: 'hub', agent: 'peri', line: 'real stderr text' })
  })

  it('非 stderr 条目（info 日志、空消息）→ none', () => {
    expect(classifyStderrEntry(unrelatedEntry())).toEqual({ kind: 'none', agent: null, line: null })
    expect(classifyStderrEntry({ source: 'x', message: '' })).toEqual({ kind: 'none', agent: null, line: null })
  })

  it('tracing 型空行："{agent} stderr: " → line 为空字符串', () => {
    expect(classifyStderrEntry(tracingEntry('peri', ''))).toEqual({ kind: 'tracing', agent: 'peri', line: '' })
  })
})

// ── 统计 ────────────────────────────────────────────────────────────────────

describe('collectStderrSamples', () => {
  it('A/B 双写计数 + ratio≈1 + correlationPresent + 新统计（hubLines=0、levels、codeCarrying）', () => {
    const entries = [
      tracingEntry('peri', 'line-1'),
      fixedTitleEntry('peri'),
      tracingEntry('peri', 'line-2'),
      fixedTitleEntry('peri', { correlation: null }), // 无 correlation 不算 present
      unrelatedEntry(),
    ]
    const { summary, perAgent } = collectStderrSamples(entries)
    expect(summary.totalLines).toBe(2)
    expect(summary.hubLines).toBe(0)
    expect(summary.totalFixedTitle).toBe(2)
    expect(summary.agents).toEqual(['peri'])
    const stat = perAgent.peri
    expect(stat.tracingLines).toBe(2)
    expect(stat.hubLines).toBe(0)
    expect(stat.fixedTitle).toBe(2)
    expect(stat.ratio).toBe(1)
    expect(stat.correlationPresent).toBe(1)
    expect(stat.codeCarrying).toBe(0) // 历史 A/B 型无 LOG-03 code 字段
    expect(stat.levels).toEqual({ error: 4, warn: 0, info: 0, debug: 0 }) // A/B 型历史恒 error
  })

  it('只有 A 型无 B 型（或反之）：A-only ratio=0（无双写）、B-only ratio=null（无行样本）', () => {
    const onlyTracing = collectStderrSamples([tracingEntry('a', 'x')])
    expect(onlyTracing.perAgent.a.ratio).toBe(0)
    const onlyFixed = collectStderrSamples([fixedTitleEntry('b')])
    expect(onlyFixed.perAgent.b.ratio).toBeNull()
    expect(onlyFixed.summary.totalLines).toBe(0)
  })

  it('POST-LOG-01 hub 单一路径：hubLines 计数 + 样本 + ratio=0 + levels 等级分布 + codeCarrying', () => {
    const entries = [
      hubEntry('peri', 'line-1', { level: 'error' }),
      hubEntry('peri', 'line-2', { level: 'warn' }),
      hubEntry('peri', 'warn-again', { level: 'warn' }),
    ]
    const { summary, perAgent } = collectStderrSamples(entries)
    expect(summary.totalLines).toBe(0)
    expect(summary.hubLines).toBe(3)
    expect(summary.totalFixedTitle).toBe(0)
    const stat = perAgent.peri
    expect(stat.tracingLines).toBe(0)
    expect(stat.hubLines).toBe(3)
    expect(stat.fixedTitle).toBe(0)
    expect(stat.ratio).toBe(0) // 无双写：无 B 型占位符
    expect(stat.levels).toEqual({ error: 1, warn: 2, info: 0, debug: 0 }) // LOG-02 解析等级直达 wire
    expect(stat.codeCarrying).toBe(3) // hub 显式 push 携带结构化 JSON code（LOG-03）
    expect(stat.correlationPresent).toBe(3)
    expect(stat.samples.map(sample => sample.line)).toEqual(['line-1', 'line-2', 'warn-again'])
  })

  it('codeCarrying：仅非空 code 计入（缺省/null 不计）', () => {
    const { perAgent } = collectStderrSamples([
      hubEntry('peri', 'a'),
      hubEntry('peri', 'b', { code: null }),
      hubEntry('peri', 'c', { code: undefined }),
      hubEntry('peri', 'd', { code: '' }),
    ])
    expect(perAgent.peri.codeCarrying).toBe(1) // 仅 a 携带非空 code
  })

  it('ratio 分母含 hub：B 型 + hub 型 → ratio=1（双重写仍可检，历史形态与生产形态混合）', () => {
    const { perAgent } = collectStderrSamples([hubEntry('peri', 'r1'), fixedTitleEntry('peri')])
    expect(perAgent.peri.hubLines).toBe(1)
    expect(perAgent.peri.fixedTitle).toBe(1)
    expect(perAgent.peri.ratio).toBe(1)
  })

  it('多 agent 分离统计', () => {
    const { perAgent } = collectStderrSamples([
      tracingEntry('peri', 'p1'), fixedTitleEntry('peri'),
      tracingEntry('hermes', 'h1'), tracingEntry('hermes', 'h2'), fixedTitleEntry('hermes'),
    ])
    expect(perAgent.peri.tracingLines).toBe(1)
    expect(perAgent.hermes.tracingLines).toBe(2)
    expect(perAgent.hermes.ratio).toBe(0.5)
    expect(Object.keys(perAgent).sort()).toEqual(['hermes', 'peri'])
  })

  it('样本取每 agent 最近 MAX_SAMPLES_PER_AGENT 条（wire 最新优先）+ 脱敏 + 升序呈现（CR-001 红黑）', () => {
    // 生产 wire 最新优先（runtime_log.rs list 无条件 .iter().rev()）：最新（secret，at=2000）在前，随后递减。
    // base 版 slice(-20) 在此序下保留最旧 20 条（丢弃 secret 与最近行）→ 本断言必失败（红黑）。
    const ascending = Array.from({ length: MAX_SAMPLES_PER_AGENT + 5 }, (_, i) =>
      tracingEntry('peri', `l${i}`, { timestamp: 1000 + i }),
    )
    ascending.push(tracingEntry('peri', 'token: abc123', { timestamp: 2000 })) // secret 形态 → REDACTED
    const newestFirst = [...ascending].reverse()
    const { perAgent } = collectStderrSamples(newestFirst)
    expect(perAgent.peri.samples.length).toBe(MAX_SAMPLES_PER_AGENT)
    // 升序呈现
    expect(perAgent.peri.samples[0].at).toBeLessThanOrEqual(perAgent.peri.samples[perAgent.peri.samples.length - 1].at)
    // 最近 20 条保留（l6..l24 + secret）；最旧 6 条（l0..l5）截断
    expect(perAgent.peri.samples.some(sample => sample.line === 'l0')).toBe(false)
    expect(perAgent.peri.samples.some(sample => sample.line === 'l5')).toBe(false)
    expect(perAgent.peri.samples[0].line).toBe('l6')
    expect(perAgent.peri.samples[perAgent.peri.samples.length - 1].line).toBe('[REDACTED]')
  })

  it('指纹聚合：相同行归并计数，按 count 降序，上限 MAX_FINGERPRINTS_PER_AGENT', () => {
    const entries = [
      ...Array.from({ length: 7 }, (_, i) => tracingEntry('peri', 'repeat-error', { timestamp: 1000 + i })),
      tracingEntry('peri', 'rare', { timestamp: 2000 }),
    ]
    const { perAgent } = collectStderrSamples(entries)
    expect(perAgent.peri.fingerprints[0]).toMatchObject({ line: 'repeat-error', count: 7 })
    expect(perAgent.peri.fingerprints.some(fp => fp.line === 'rare')).toBe(true)
    expect(perAgent.peri.fingerprints.length).toBeLessThanOrEqual(MAX_FINGERPRINTS_PER_AGENT)
  })

  it('secret 行脱敏后同指纹归并（两条不同 secret → 同为 [REDACTED]）', () => {
    const { perAgent } = collectStderrSamples([
      tracingEntry('peri', 'sk-proj-aaaa'),
      tracingEntry('peri', 'sk-proj-bbbb'),
    ])
    const fingerprint = perAgent.peri.fingerprints.find(fp => fp.line === '[REDACTED]')
    expect(fingerprint).toMatchObject({ line: '[REDACTED]', count: 2 })
  })
})

// ── P5 判定 ────────────────────────────────────────────────────────────────

describe('buildP5Checks', () => {
  it('窗口证据：Runtime sheet 静态登记（kind/label/renderKey/renderer/singleWindow）', () => {
    expect(RUNTIME_WINDOW_EVIDENCE).toMatchObject({
      sheetKind: 'runtime', label: 'Runtime', renderKey: 'runtime-sheet',
      renderer: 'RuntimeSheetView', singleWindowApp: true,
    })
  })

  it('双重写确认 + 样本可用 + correlationDroppedFrontend 结构性常量', () => {
    const { summary, perAgent } = collectStderrSamples([tracingEntry('peri', 'x'), fixedTitleEntry('peri')])
    const checks = buildP5Checks({ summary, perAgent })
    expect(checks.doubleWriteConfirmed).toBe(true)
    expect(checks.samplesAvailable).toBe(true)
    expect(checks.totalStderrLines).toBe(1)
    expect(checks.correlationDroppedFrontend).toBe(false) // LOG-03：normalize 保留 correlation
    expect(checks.windowIdentified.evidence).toContain('src/workspace-sheets/sheetRegistry.ts:10')
  })

  it('无 stderr 数据 → doubleWriteConfirmed=false、samplesAvailable=false', () => {
    const { summary, perAgent } = collectStderrSamples([unrelatedEntry()])
    const checks = buildP5Checks({ summary, perAgent })
    expect(checks.doubleWriteConfirmed).toBe(false)
    expect(checks.samplesAvailable).toBe(false)
    expect(checks.totalStderrLines).toBe(0)
  })

  it('POST-LOG-01：仅 hub 真实行 → 无双写（单一路径）、样本可用、totalStderrLines=hubLines', () => {
    const { summary, perAgent } = collectStderrSamples([hubEntry('peri', 'boom'), hubEntry('hermes', 'crash')])
    const checks = buildP5Checks({ summary, perAgent })
    expect(checks.doubleWriteConfirmed).toBe(false) // 无 B 型占位符 = 单一路径
    expect(checks.samplesAvailable).toBe(true)
    expect(checks.totalStderrLines).toBe(2)
  })

  it('B 型 + hub 混合 → 双重写仍可确认（分母含 hub）', () => {
    const { summary, perAgent } = collectStderrSamples([hubEntry('peri', 'real'), fixedTitleEntry('peri')])
    const checks = buildP5Checks({ summary, perAgent })
    expect(checks.doubleWriteConfirmed).toBe(true)
    expect(checks.totalStderrLines).toBe(1) // hub 1 行；B 型占位符不计
  })
})

// ── 工件组装 ────────────────────────────────────────────────────────────────

describe('buildStderrSamplesArtifact', () => {
  it('tool/schemaVersion/phase + 统计 + P5 判定', () => {
    const artifact = buildStderrSamplesArtifact({
      phase: 'after-crash',
      entries: [tracingEntry('peri', 'boom'), fixedTitleEntry('peri')],
    })
    expect(artifact.tool).toBe('obs07-stderr-samples')
    expect(artifact.schemaVersion).toBe(2) // LOG-04：perAgent 增 hubLines/levels/codeCarrying、summary 增 hubLines
    expect(artifact.phase).toBe('after-crash')
    expect(artifact.summary.totalLines).toBe(1)
    expect(artifact.perAgent.peri.samples[0].line).toBe('boom')
    expect(artifact.p5Checks.doubleWriteConfirmed).toBe(true)
    expect(artifact.p5Checks.correlationDroppedFrontend).toBe(false) // LOG-03：normalize 保留 correlation
  })

  it('hub 生产形态工件：schemaVersion 2 + hubLines + levels + codeCarrying + 无双写', () => {
    const artifact = buildStderrSamplesArtifact({
      phase: 'post-log-01',
      entries: [hubEntry('peri', 'boom'), hubEntry('peri', 'warn-line', { level: 'warn' })],
    })
    expect(artifact.schemaVersion).toBe(2)
    expect(artifact.summary.hubLines).toBe(2)
    expect(artifact.summary.totalLines).toBe(0)
    expect(artifact.perAgent.peri.hubLines).toBe(2)
    expect(artifact.perAgent.peri.levels).toEqual({ error: 0, warn: 1, info: 1, debug: 0 })
    expect(artifact.perAgent.peri.codeCarrying).toBe(2)
    expect(artifact.perAgent.peri.correlationPresent).toBe(2)
    expect(artifact.p5Checks.doubleWriteConfirmed).toBe(false)
    expect(artifact.p5Checks.samplesAvailable).toBe(true)
    expect(artifact.p5Checks.totalStderrLines).toBe(2)
  })

  it('脱敏：样本行内 secret 形态值 REDACTED（工件 JSON 不含原文）', () => {
    const artifact = buildStderrSamplesArtifact({
      phase: 'manual',
      entries: [tracingEntry('peri', 'auth failed, api key sk-proj-leak present')],
    })
    const json = JSON.stringify(artifact)
    expect(json).not.toContain('sk-proj-leak')
    expect(json).toContain('[REDACTED]')
  })

  it('CR-001 对齐：样本行内嵌绝对路径收窄为目录名（工件不含绝对路径）', () => {
    const artifact = buildStderrSamplesArtifact({
      phase: 'manual',
      entries: [tracingEntry('peri', 'cwd G:/work/prism-desktop failed')],
    })
    const json = JSON.stringify(artifact)
    expect(json).not.toContain('G:/work')
    expect(json).toContain('…/prism-desktop')
    expect(artifact.perAgent.peri.samples[0].line).toBe('cwd …/prism-desktop failed')
  })

  it('narrowEmbeddedPaths：盘符/UNC/根相对嵌路径收窄；/help 单段与普通文本不误伤', () => {
    expect(narrowEmbeddedPaths('err C:\\Users\\me\\app\\db.sqlite!')).toBe('err …/db.sqlite!')
    expect(narrowEmbeddedPaths('open //server/share/app ok')).toBe('open …/app ok')
    expect(narrowEmbeddedPaths('no /home/u/proj')).toBe('no …/proj')
    expect(narrowEmbeddedPaths('try /help now')).toBe('try /help now')
    expect(narrowEmbeddedPaths('C:/x is root')).toBe('…/x is root')
    expect(narrowEmbeddedPaths('plain message')).toBe('plain message')
  })

  it('CR-002 闭环：日期形态全数字段豁免，不误收窄（2026/08/14 原样）', () => {
    expect(narrowEmbeddedPaths('on 2026/08/14 finished')).toBe('on 2026/08/14 finished')
    expect(narrowEmbeddedPaths('v 5/10/2026 released')).toBe('v 5/10/2026 released')
    expect(narrowEmbeddedPaths('G:/work/2026/08/log.txt')).toBe('…/log.txt') // 真实路径仍收窄
  })

  it('非路径形态的提示性文本（/help 单段）不收窄；普通文本原样', () => {
    const artifact = buildStderrSamplesArtifact({
      phase: 'manual',
      entries: [tracingEntry('peri', 'try /help')],
    })
    expect(artifact.perAgent.peri.samples[0].line).toBe('try /help')
  })

  it('空 hub（无 stderr 条目）→ 空统计 + 判定为不可用（不报错）', () => {
    const artifact = buildStderrSamplesArtifact({ phase: 'manual', entries: [] })
    expect(artifact.summary.totalLines).toBe(0)
    expect(artifact.p5Checks.samplesAvailable).toBe(false)
    expect(artifact.p5Checks.doubleWriteConfirmed).toBe(false)
  })
})
