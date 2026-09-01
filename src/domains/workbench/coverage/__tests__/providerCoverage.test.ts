import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  allCoverageItems, EXPECTED_UNITS, PROVIDER_COVERAGE, summarize,
} from '../providerCoverageIndex.ts'
import { BUILTIN_TEXT_RENDER_KINDS } from '../../../rendererContent/textRenderKindCatalog.ts'
import { BUILTIN_EXECUTION_RENDER_KINDS } from '../../../rendererContent/executionRenderKindCatalog.ts'
import { normalizeAgentEvent, type NormalizeContext } from '../../normalizers/agentEventNormalizer.ts'

/**
 * C16 / DIC-C16-01：三 provider 全覆盖审计的机器可读门禁。
 * 完成定义：121 项（44/46/31）逐项有状态/证据/锚点；SOURCE-ONLY（not-transported）
 * 明确列为未覆盖；normalized 项必须能给出 catalog/renderKind 或明确的非渲染语义。
 */

const ALL_STATUSES = ['normalized', 'flattened-with-reason', 'not-transported', 'unknown-fallback'] as const
const ALL_TRANSPORT_STATUSES = [
  'WIRE-STANDARD',
  'WIRE-EXTENSION',
  'SYNTHETIC',
  'SOURCE-ONLY/BACKLOG',
] as const

function context(provider: string): NormalizeContext {
  return {
    provider,
    sessionId: 'coverage-session',
    sourceId: `coverage:${provider}`,
    sequence: 1,
    recordedAt: '2026-08-24T00:00:00.000Z',
    provenance: { origin: 'local-observed', trust: 'authoritative', provider, orderConfidence: 'observed' },
  }
}

describe('C16 provider coverage inventory', () => {
  it('映射单元数与字典 §十 精确一致（44/46/31）', () => {
    for (const provider of ['claude-code', 'peri', 'hermes'] as const) {
      const items = PROVIDER_COVERAGE[provider]
      expect(items.length, `${provider} 映射单元数`).toBe(EXPECTED_UNITS[provider])
    }
    expect(allCoverageItems().length).toBe(121)
  })

  it('每项都有完整字段：状态合法、证据/fixture/followUp 按状态要求', () => {
    const seen = new Set<string>()
    for (const item of allCoverageItems()) {
      expect(seen.has(item.id), `id 重复: ${item.id}`).toBe(false)
      seen.add(item.id)
      expect(ALL_STATUSES).toContain(item.status)
      expect(item.wireSymbol.trim().length).toBeGreaterThan(0)
      expect(item.dictionarySection.startsWith('§'), `${item.id} 缺字典节锚点`).toBe(true)
      // normalized 必须给出 Pylon 锚点与 semantic event
      if (item.status === 'normalized') {
        expect(item.pylonAnchors.length, `${item.id} normalized 但无 Pylon 锚点`).toBeGreaterThan(0)
        expect(item.semanticEvent.length).toBeGreaterThan(0)
      }
      // not-transported 必须登记上游 follow-up，且不得伪造 semanticEvent
      if (item.status === 'not-transported') {
        expect(item.followUp, `${item.id} not-transported 缺上游任务`).toMatch(/ACP-UP-\d+/)
        expect(item.semanticEvent, `${item.id} source-only 不得写目标 semanticEvent`).toBe('')
        expect(item.renderKind, `${item.id} source-only 不得写目标 renderer`).toBe('')
        expect(item.firstClassFields, `${item.id} source-only 没有 first-class fields`).toEqual([])
      }
      // flattened-with-reason 必须写明原因
      if (item.status === 'flattened-with-reason') {
        expect(item.retainedOnlyFields.length, `${item.id} flattened 未记录保留 raw 证据`).toBeGreaterThan(0)
      }
      // unknown-fallback 至少要有 unknown 兜底路径锚点
      if (item.status === 'unknown-fallback') {
        const anchors = item.pylonAnchors.join(' ')
        expect(
          anchors.includes('unknown') || anchors.includes('generic')
            || anchors.includes('diagnostic-only') || item.semanticEvent.includes('diagnostic'),
          `${item.id} unknown-fallback 无兜底证据`,
        ).toBe(true)
      }
    }
  })

  it('逐项声明 wire 分级，SOURCE-ONLY/BACKLOG 不得冒充 unknown fallback', () => {
    for (const item of allCoverageItems()) {
      expect(ALL_TRANSPORT_STATUSES, `${item.id} 缺 transport status`).toContain(item.transportStatus)
      if (item.transportStatus === 'SOURCE-ONLY/BACKLOG') {
        expect(item.status, `${item.id} source-only 不得计作到达 wire 后的 fallback`).toBe('not-transported')
      }
      if (item.status === 'unknown-fallback') {
        expect(
          item.transportStatus === 'WIRE-STANDARD' || item.transportStatus === 'WIRE-EXTENSION',
          `${item.id} unknown fallback 必须有实际 wire carrier`,
        ).toBe(true)
      }
    }
  })

  it('锁定 transport 分布并双向隔离 SOURCE-ONLY 与 Pylon 消费证据', () => {
    const items = allCoverageItems()
    const sourceOnly = items.filter(item => item.transportStatus === 'SOURCE-ONLY/BACKLOG')
    const notTransported = items.filter(item => item.status === 'not-transported')

    expect(sourceOnly.map(item => item.id).sort(), 'SOURCE-ONLY 必须与 not-transported 双向一致')
      .toEqual(notTransported.map(item => item.id).sort())
    expect(sourceOnly, '固定 provider revision 下的 SOURCE-ONLY 分布发生未审计漂移').toHaveLength(47)
    for (const item of sourceOnly) {
      expect(item.pylonAnchors, `${item.id} 未到 wire，不得保留目标 seam/unknown fallback 等 Pylon 消费锚点`)
        .toEqual([])
    }

    expect(items.filter(item => item.transportStatus === 'WIRE-EXTENSION').map(item => item.id),
      '当前没有经协商且有 fixture 的 provider extension wire').toEqual([])
    expect(items.filter(item => item.transportStatus === 'SYNTHETIC').map(item => item.id),
      '只有 Claude prompt response 由 host 合成为 canonical done').toEqual(['cc-14'])
  })

  it('不把 provider 源码目标语义或目标卡片就绪冒充实际 wire 消费', () => {
    const items = new Map(allCoverageItems().map(item => [item.id, item]))
    for (const id of ['hm-11', 'hm-12'] as const) {
      expect(items.get(id)?.transportStatus, `${id} 内部 delegation 没有协商扩展 carrier`).toBe('SOURCE-ONLY/BACKLOG')
      expect(items.get(id)?.status).toBe('not-transported')
    }
    expect(items.get('hm-21')).toMatchObject({
      transportStatus: 'WIRE-STANDARD', status: 'unknown-fallback', renderKind: 'tool.generic',
    })
    for (const id of ['peri-40', 'peri-41'] as const) {
      expect(items.get(id)?.status, `${id} 只有 tool kind/rawOutput，不能计 typed content/diagnostic`).toBe('unknown-fallback')
      expect(items.get(id)?.firstClassFields).not.toContain(expect.stringMatching(/diagnostic|content\.skill/))
    }
  })

  it('Peri/Hermes 缺少 machine tool identity 时只认标准 ACP kind 或 generic fallback', () => {
    const rows = allCoverageItems().filter(item =>
      (item.provider === 'peri' && item.dictionarySection.startsWith('§五'))
      || (item.provider === 'hermes' && item.dictionarySection.startsWith('§七')),
    )
    for (const item of rows) {
      if (!item.semanticEvent.includes('tool.')) continue
      expect(
        item.renderKind,
        `${item.id} 缺 _meta.pylon.toolName，不得从 title/raw 宣称 content/activity/interaction 等 provider-specific 语义`,
      ).not.toMatch(/content\.|activity\.|interaction\.|diagnostic\.|plan\.|goal\./)
      if (item.status === 'unknown-fallback') {
        expect(item.renderKind.split('/'), `${item.id} 缺 machine name 时必须包含 generic tool`).toContain('tool.generic')
        expect(item.pylonAnchors.join(' '), `${item.id} 缺少 machine-name 降级诊断证据`).toMatch(/generic|unknown|toolName/i)
      }
    }
  })

  it('Peri 事件结论服从 mapper 的实际 SessionUpdate 输出', () => {
    const items = new Map(PROVIDER_COVERAGE.peri.map(item => [item.id, item]))

    for (const id of ['peri-05', 'peri-07'] as const) {
      expect(items.get(id), `${id} mapper 明确零输出，不得拿目标 projector 冒充 wire`).toMatchObject({
        status: 'not-transported',
        transportStatus: 'SOURCE-ONLY/BACKLOG',
        semanticEvent: '',
      })
    }
    expect(items.get('peri-09'), 'SyntheticUserMessage 实际映射为标准 user_message_chunk').toMatchObject({
      status: 'normalized',
      transportStatus: 'WIRE-STANDARD',
      semanticEvent: 'message.delta',
    })
  })

  it('Peri reasoning 区分 Render wire 与 Observe tracer，不冒充子代理 source identity', () => {
    const item = PROVIDER_COVERAGE.peri.find(row => row.id === 'peri-02')
    expect(item).toMatchObject({
      status: 'normalized',
      transportStatus: 'WIRE-STANDARD',
      semanticEvent: 'reasoning.delta',
      firstClassFields: ['parts[].text'],
    })
    expect(item?.retainedOnlyFields.join(' '), 'Observe reasoning 不进入 SessionUpdate').toMatch(/Observe.*tracer|tracer.*Observe/i)
    expect(item?.retainedOnlyFields.join(' '), '_peri.sourceAgentId 尚未被 Workbench normalizer 消费').toMatch(/sourceAgentId.*未.*normalizer|normalizer.*未.*sourceAgentId/i)
    expect(item?.followUp).toMatch(/ACP-UP-\d+/)

    const normalized = normalizeAgentEvent({
      sessionId: 'peri-wire',
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'trace' } },
      _peri: { sourceAgentId: 'child-agent' },
    }, { ...context('peri'), agentId: 'session-owner' })
    expect(normalized.events[0]?.source.agentId, '当前 source 仍是 session owner，不得冒充 child-agent').toBe('session-owner')
  })

  it('Peri content/tool/plan 结论不超过 mapper 实际构造的 ACP shape', () => {
    const items = new Map(PROVIDER_COVERAGE.peri.map(item => [item.id, item]))

    expect(items.get('peri-28'), '内部 ContentBlock 全家族没有对应 ACP carrier').toMatchObject({
      status: 'not-transported', transportStatus: 'SOURCE-ONLY/BACKLOG', semanticEvent: '', firstClassFields: [],
    })
    for (const id of ['peri-29', 'peri-31', 'peri-32'] as const) {
      expect(items.get(id)?.firstClassFields.join(' '), `${id} 只能声明 coarse tool fields`).not.toMatch(/locations|result parts|typed/i)
      expect(items.get(id)?.firstClassFields.join(' '), `${id} raw input/output 实际可达`).toMatch(/rawInput|rawOutput/)
    }
    expect(items.get('peri-29')?.retainedOnlyFields.join(' '), 'reading alias 不在 infer_tool_kind').toMatch(/reading.*generic|generic.*reading/i)
    expect(items.get('peri-35')).toMatchObject({
      status: 'normalized', semanticEvent: 'plan.replaced',
      firstClassFields: expect.arrayContaining(['entries content/status/priority=medium']),
    })
    expect(items.get('peri-35')?.firstClassFields.join(' ')).not.toMatch(/activeForm|metadata/)
    expect(items.get('peri-35')?.retainedOnlyFields.join(' ')).toMatch(/activeForm.*drop|drop.*activeForm/i)
  })

  it('Claude 事件结论区分 session/update、prompt response 与不可逆文本扁平化', () => {
    const items = new Map(PROVIDER_COVERAGE['claude-code'].map(item => [item.id, item]))

    for (const id of ['cc-02', 'cc-03'] as const) {
      expect(items.get(id)?.semanticEvent, `${id} bridge 发出的是 message chunk`).toBe('message.delta')
    }
    for (const id of ['cc-05', 'cc-13'] as const) {
      expect(items.get(id), `${id} 没有可观察 session/update carrier`).toMatchObject({
        status: 'not-transported',
        transportStatus: 'SOURCE-ONLY/BACKLOG',
        semanticEvent: '',
      })
    }
    expect(items.get('cc-14'), 'prompt response 只经 host 合成为 canonical done').toMatchObject({
      status: 'flattened-with-reason',
      transportStatus: 'SYNTHETIC',
      semanticEvent: 'session.completed',
    })
    expect(items.get('cc-17'), 'progress 只以普通 agent_message_chunk 到达').toMatchObject({
      status: 'flattened-with-reason',
      transportStatus: 'WIRE-STANDARD',
      semanticEvent: 'message.delta',
      renderKind: 'content.text',
    })
  })

  it('Claude usage 只把 session/update 实际携带的 used/size 计为 first-class', () => {
    const items = new Map(PROVIDER_COVERAGE['claude-code'].map(item => [item.id, item]))

    expect(items.get('cc-11'), 'result.usage breakdown 只返回 prompt response，当前没有 canonical usage carrier').toMatchObject({
      status: 'not-transported',
      transportStatus: 'SOURCE-ONLY/BACKLOG',
      semanticEvent: '',
      firstClassFields: [],
    })
    expect(items.get('cc-12'), 'usage_update 实际只携带 used/size').toMatchObject({
      status: 'normalized',
      transportStatus: 'WIRE-STANDARD',
      semanticEvent: 'usage.updated',
      firstClassFields: ['usage.contextUsed', 'usage.contextLimit', 'usage.contextPercent'],
    })
    expect(items.get('cc-12')?.retainedOnlyFields.join(' '), 'message.model 只用于 bridge 内部匹配 context window').toMatch(/model.*bridge|bridge.*model/i)
  })

  it('Claude tool start/progress 只声明 bridge 实际产生的 kind 与 update 字段', () => {
    const items = new Map(PROVIDER_COVERAGE['claude-code'].map(item => [item.id, item]))

    expect(items.get('cc-07')?.renderKind.split('/'), 'Write 与 Edit 均为 ACP edit，不存在 tool.write').toEqual([
      'tool.generic', 'tool.read', 'tool.edit', 'tool.search', 'tool.fetch', 'tool.execute',
    ])
    expect(items.get('cc-08')).toMatchObject({
      semanticEvent: 'tool.progress',
      firstClassFields: expect.arrayContaining(['identity.toolCallId', 'tool.status=in_progress', 'tool.input/rawInput']),
    })
    expect(items.get('cc-08')?.firstClassFields.join(' '), 'bridge 没有发送 progress.label').not.toMatch(/progress\.label/)
  })

  it('Claude/Peri 不把未发送的终态、错误、plan 或 alias 字段计为 first-class', () => {
    const claude = new Map(PROVIDER_COVERAGE['claude-code'].map(item => [item.id, item]))
    const peri = new Map(PROVIDER_COVERAGE.peri.map(item => [item.id, item]))

    expect(claude.get('cc-03')?.firstClassFields.join(' ')).not.toMatch(/provenance/)
    expect(claude.get('cc-03')?.retainedOnlyFields.join(' ')).toMatch(/isReplay.*未.*wire|wire.*未.*isReplay/i)
    expect(claude.get('cc-04')?.firstClassFields.join(' ')).not.toMatch(/thoughtDuration/)
    expect(claude.get('cc-04')?.retainedOnlyFields.join(' ')).toMatch(/终态.*未.*wire|wire.*未.*终态/i)
    expect(claude.get('cc-09')?.firstClassFields.join(' ')).not.toMatch(/error/)
    expect(claude.get('cc-09')?.retainedOnlyFields.join(' ')).toMatch(/is_error.*status|status.*is_error/i)
    expect(claude.get('cc-31')?.firstClassFields).toEqual(['entries[].content/status/priority=medium'])

    expect(peri.get('peri-03')?.firstClassFields.join(' ')).not.toMatch(/turnId/)
    expect(peri.get('peri-04')?.firstClassFields).toEqual(['result.status'])
    expect(peri.get('peri-09')?.firstClassFields).toEqual(['role=user', 'parts[].text'])
    for (const [id, specificKind] of [['peri-29', 'tool.read'], ['peri-30', 'tool.edit'], ['peri-33', 'tool.execute']] as const) {
      expect(peri.get(id)).toMatchObject({ status: 'unknown-fallback', renderKind: `${specificKind}/tool.generic` })
      expect(peri.get(id)?.retainedOnlyFields.join(' ')).toMatch(/alias|SandboxWrite|Shell/)
    }
  })

  it('Claude machine tool identity 不得冒充 bridge 未产生的 typed content/activity', () => {
    const rows = PROVIDER_COVERAGE['claude-code'].filter(item => item.dictionarySection.startsWith('§三'))
    for (const item of rows) {
      expect(
        item.renderKind,
        `${item.id} toolInfo/toolResults 没有产生对应 typed family`,
      ).not.toMatch(/content\.(search-result|link|markdown|terminal|memory|skill|mcp-resource|artifact)|activity\.|diagnostic\.lsp/)
    }

    const expectedKinds = new Map<string, string>([
      ['cc-24', 'tool.read'],
      ['cc-26', 'tool.search'],
      ['cc-28', 'tool.generic'],
      ['cc-31', ''],
      ['cc-35', 'tool.fetch/tool.generic'],
      ['cc-37', 'tool.generic'],
      ['cc-39', 'tool.generic'],
      ['cc-44', 'tool.generic'],
    ])
    for (const [id, renderKind] of expectedKinds) {
      expect(rows.find(item => item.id === id)?.renderKind, `${id} coarse carrier 结论`).toBe(renderKind)
    }
  })

  it('Peri/Hermes 的 tool event 只保留 wire kind，不宣称缺失的 machine name', () => {
    const rows = new Map(allCoverageItems().map(item => [item.id, item]))
    for (const id of ['peri-03', 'peri-04', 'hm-03', 'hm-04'] as const) {
      expect(rows.get(id)?.firstClassFields.join(' '), `${id} first-class identity`).not.toMatch(/tool\.name/)
      expect(rows.get(id)?.retainedOnlyFields.join(' '), `${id} 必须登记 machine name 缺口`).toMatch(/machine|toolName/i)
    }
  })

  it('Hermes tool lifecycle 不把 polished formatter 丢弃的 raw/error 字段计为 first-class', () => {
    const items = new Map(PROVIDER_COVERAGE.hermes.map(item => [item.id, item]))

    expect(items.get('hm-03')?.firstClassFields.join(' ')).toMatch(/status.*title.*kind|kind.*status.*title/i)
    expect(items.get('hm-03')?.firstClassFields.join(' ')).not.toMatch(/tool\.input|rawInput/)
    expect(items.get('hm-03')?.retainedOnlyFields.join(' ')).toMatch(/rawInput.*polished|polished.*rawInput/i)
    expect(items.get('hm-04')?.firstClassFields.join(' ')).toMatch(/status.*parts|parts.*status/i)
    expect(items.get('hm-04')?.firstClassFields.join(' ')).not.toMatch(/error/)
    expect(items.get('hm-04')?.retainedOnlyFields.join(' ')).toMatch(/error.*status|status.*error/i)
  })

  it('用真实 normalizer 公共入口证明 machine identity、coarse kind 与文本扁平化边界', () => {
    const claude = normalizeAgentEvent({ update: {
      sessionUpdate: 'tool_call', toolCallId: 'claude-agent', title: 'delegate', kind: 'think',
      rawInput: { prompt: 'inspect' }, _meta: { claudeCode: { toolName: 'Agent' } },
    } }, context('claude-code'))
    expect(claude.events[0]?.event).toMatchObject({
      type: 'tool.started',
      tool: { name: 'Agent', semanticKind: 'tool.think', action: 'think' },
    })
    expect(JSON.stringify(claude.events[0]?.event)).not.toMatch(/activity\.subagent|content\.skill/)

    for (const provider of ['peri', 'hermes'] as const) {
      const coarse = normalizeAgentEvent({ update: {
        sessionUpdate: 'tool_call', toolCallId: `${provider}-read`, title: 'localized title', kind: 'read',
        rawInput: { path: 'README.md' },
      } }, context(provider))
      expect(coarse.events[0]?.event).toMatchObject({
        type: 'tool.started', tool: { name: 'unknown', semanticKind: 'tool.read' },
      })
      expect(coarse.diagnostics.map(item => item.code)).toContain('tool.name.missing')

      const generic = normalizeAgentEvent({ update: {
        sessionUpdate: 'tool_call', toolCallId: `${provider}-other`, title: 'Skill', kind: 'other',
      } }, context(provider))
      const expectedGenericName = provider === 'hermes' ? 'skill_view' : 'unknown'
      expect(generic.events[0]?.event).toMatchObject({
        type: 'tool.started', tool: { name: expectedGenericName, semanticKind: 'tool.other' },
      })
      if (provider === 'peri') expect(generic.diagnostics.map(item => item.code)).toContain('tool.name.missing')
    }

    const flattened = normalizeAgentEvent({ update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Agent progress: 50%' },
    } }, context('claude-code'))
    expect(flattened.events[0]?.event).toEqual(expect.objectContaining({ type: 'message.delta', role: 'assistant' }))
    expect(JSON.stringify(flattened.events[0]?.event)).not.toContain('activity.progress')
  })

  it('逐项记录可验证的全链 evidence，source-only 显式记录不可达原因', () => {
    const downstream = [
      'identity', 'provenance', 'normalizer', 'projector', 'solidRenderer',
      'reactFallback', 'settingsSchema', 'pluginLifecycle', 'tests',
    ] as const

    for (const item of allCoverageItems()) {
      expect(item.evidence.source.state, `${item.id} 缺 provider source evidence`).toBe('verified')
      expect(item.evidence.source.refs.length, `${item.id} provider source evidence 为空`).toBeGreaterThan(0)
      for (const ref of item.evidence.source.refs) {
        expect(() => readFileSync(ref, 'utf-8'), `${item.id} provider source 引用不存在: ${ref}`).not.toThrow()
      }

      if (item.transportStatus === 'SOURCE-ONLY/BACKLOG') {
        const wireFixture = item.evidence.wireFixture
        expect(wireFixture.state, `${item.id} 应显式记录 wire fixture 不可得`).toBe('unavailable')
        if (wireFixture.state !== 'unavailable') throw new Error(`${item.id} wire fixture 状态未收窄`)
        expect(wireFixture.reason, `${item.id} 缺 wire gap 原因`).toMatch(/ACP-UP-\d+/)
        for (const key of downstream) {
          const claim = item.evidence[key]
          expect(claim.state, `${item.id}.${key} 不得拿目标 seam 冒充实际消费`).toBe('not-applicable')
          if (claim.state !== 'not-applicable') throw new Error(`${item.id}.${key} 状态未收窄`)
          expect(claim.reason.trim().length, `${item.id}.${key} 缺不适用原因`).toBeGreaterThan(0)
        }
        continue
      }

      const providerFixture = item.provider === 'claude-code'
        ? /claude-code-main\/src\/services\/acp\/__tests__\/bridge\.test\.ts/
        : item.provider === 'peri'
          ? /Peri\/peri-acp\/(src\/event\/mapper_test|tests\/integration_test)\.rs/
          : /Hermes\/hermes-agent\/tests\/acp\/test_(events|tools)\.py/
      const wireClaim = item.evidence.wireFixture
      expect(wireClaim.state, `${item.id}.wireFixture 未验证`).toBe('verified')
      if (wireClaim.state !== 'verified') throw new Error(`${item.id}.wireFixture 状态未收窄`)
      expect(wireClaim.refs.join('/'), `${item.id} 缺 provider adapter fixture`).toMatch(providerFixture)
      expect(wireClaim.refs, `${item.id} 缺 Pylon wire normalization fixture`)
        .toContain('src/domains/workbench/coverage/__tests__/providerCoverage.test.ts')

      const normalizerClaim = item.evidence.normalizer
      expect(normalizerClaim.state, `${item.id}.normalizer 未验证`).toBe('verified')
      if (normalizerClaim.state !== 'verified') throw new Error(`${item.id}.normalizer 状态未收窄`)
      expect(normalizerClaim.refs.join(' '), `${item.id} 缺 provider seam normalizer`).toContain(`${item.provider === 'claude-code' ? 'claudeCode' : item.provider}Normalizer.ts`)

      const cleanupClaim = item.evidence.pluginLifecycle
      expect(cleanupClaim.state, `${item.id}.pluginLifecycle 未验证`).toBe('verified')
      if (cleanupClaim.state !== 'verified') throw new Error(`${item.id}.pluginLifecycle 状态未收窄`)
      expect(cleanupClaim.note, `${item.id} 不得声称逐行独立 lifecycle`).toMatch(/family-level/i)

      if (item.transportStatus === 'SYNTHETIC') {
        expect(item.evidence.provenance.state, `${item.id} synthetic provenance 缺口不得盖章`).toBe('unavailable')
        if (item.evidence.provenance.state !== 'unavailable') throw new Error(`${item.id}.provenance 状态未收窄`)
        expect(item.evidence.provenance.reason).toMatch(/synthetic/i)
      }

      for (const key of ['wireFixture', ...downstream] as const) {
        if (item.transportStatus === 'SYNTHETIC' && key === 'provenance') continue
        const claim = item.evidence[key]
        expect(claim.state, `${item.id}.${key} 未验证`).toBe('verified')
        if (claim.state !== 'verified') throw new Error(`${item.id}.${key} 状态未收窄`)
        expect(claim.refs.length, `${item.id}.${key} 无证据引用`).toBeGreaterThan(0)
        for (const ref of claim.refs) {
          expect(() => readFileSync(ref, 'utf-8'), `${item.id}.${key} 引用不存在: ${ref}`).not.toThrow()
        }
      }
    }
  })

  it('可达项的 renderer/settings evidence 命中实际 semantic family，不用 App 壳层充数', () => {
    for (const item of allCoverageItems()) {
      if (item.transportStatus === 'SOURCE-ONLY/BACKLOG') continue
      const solidRefs = item.evidence.solidRenderer.state === 'verified'
        ? item.evidence.solidRenderer.refs.join(' ') : ''
      const settingRefs = item.evidence.settingsSchema.state === 'verified'
        ? item.evidence.settingsSchema.refs.join(' ') : ''
      const semantic = `${item.semanticEvent} ${item.renderKind}`

      if (semantic.includes('tool.')) expect(solidRefs, `${item.id} tool renderer`).toContain('ToolInvocationCard.solid.tsx')
      if (semantic.includes('content.')) expect(solidRefs, `${item.id} content Slot`).toContain('BuiltinSolidContentSlot.solid.tsx')
      if (semantic.includes('activity.')) expect(solidRefs, `${item.id} activity renderer`).toMatch(/SubagentCard|WorkflowCard|TerminalBlock/)
      if (/interaction\./.test(semantic)) expect(solidRefs, `${item.id} interaction renderer`).toContain('InteractionCard.solid.tsx')
      if (/plan\.|goal\./.test(semantic)) expect(solidRefs, `${item.id} plan renderer`).toMatch(/GoalCard|PlanGoalContent/)
      if (/lifecycle\./.test(semantic)) expect(solidRefs, `${item.id} lifecycle renderer`).toContain('LifecycleCard.solid.tsx')
      if (/usage\.|budget\.|session\./.test(semantic)) expect(solidRefs, `${item.id} session renderer`).toContain('SessionSurfaceCard.solid.tsx')
      if (/message\.|reasoning\./.test(semantic)) expect(solidRefs, `${item.id} message renderer`).toContain('MessageRow.solid.tsx')

      if (semantic.includes('tool.')) expect(settingRefs, `${item.id} tool settings`).toContain('toolRenderKindCatalog.ts')
      if (semantic.includes('content.')) expect(settingRefs, `${item.id} content settings`).toContain('textRenderKindCatalog.ts')
      if (semantic.includes('activity.')) expect(settingRefs, `${item.id} activity settings`).toContain('executionRenderKindCatalog.ts')
      if (semantic.includes('interaction.')) expect(settingRefs, `${item.id} interaction settings`).toContain('interactionRenderKindCatalog.ts')
      if (/usage\.|budget\.|session\./.test(semantic)) expect(settingRefs, `${item.id} session settings`).toContain('sessionRenderKindCatalog.ts')
      if (/plan\.|goal\.|lifecycle\./.test(semantic)) expect(settingRefs, `${item.id} plan/lifecycle settings`).toContain('builtinRenderContent.ts')
    }
  })

  it('normalized 项的 renderKind 在 A07 catalog 有 definition（注册≠渲染反向锁）', () => {
    const catalogKinds = new Set<string>([
      ...BUILTIN_TEXT_RENDER_KINDS.map(kind => kind.id),
      ...BUILTIN_EXECUTION_RENDER_KINDS.map(kind => kind.id),
      // 非 content/activity 渲染面的 semantic kinds（tool.* 走工具卡、lifecycle 走 LifecycleCard、
      // interaction/usage/session 走 App surface）——这些不要求 catalog registration：
      'tool.read', 'tool.search', 'tool.fetch', 'tool.execute', 'tool.edit',
      'tool.generic',
    ])
    for (const item of allCoverageItems()) {
      if (item.status !== 'normalized' || !item.renderKind) continue
      for (const kind of item.renderKind.split('/')) {
        const k = kind.trim()
        if (!k || k === '' ) continue
        // lifecycle 卡 / tool 卡等语义面允许白名单外描述，但 content./activity./tool. 前缀必须命中
        if (k.startsWith('content.') || k.startsWith('activity.') || k.startsWith('tool.')
          || k.startsWith('diagnostic.')) {
          expect(catalogKinds.has(k), `${item.id}: renderKind '${k}' 不在 catalog`).toBe(true)
        }
      }
    }
  })

  it('SOURCE-ONLY(not-transported) 明确列为未覆盖——汇总不得把它们计入已覆盖', () => {
    for (const provider of ['claude-code', 'peri', 'hermes'] as const) {
      const s = summarize(provider)
      const covered = s.byStatus.normalized ?? 0
      const total = s.totalUnits
      // not-transported + unknown-fallback + flattened 都不算完整覆盖
      const notCovered = total - covered
      expect(s.byStatus['not-transported'] + s.byStatus['unknown-fallback'] + s.byStatus['flattened-with-reason'])
        .toBe(notCovered)
      // 审计结论必须诚实：不允许宣称 100% normalized 全覆盖
      expect(covered, `${provider} 不应有虚假全覆盖`).toBeLessThan(total)
    }
  })
})
