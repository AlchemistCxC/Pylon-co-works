import { describe, expect, it } from 'vitest'
import {
  normalizeAgentStatus,
  selectAgentStatus,
  statusLabel,
  type AgentConnectionStatus,
  type AgentStatus,
} from '../agentTypes'

describe('normalizeAgentStatus — 状态缺失/非法归一化矩阵（ISSUE-03 §6.4 L1）', () => {
  it('payload 缺少 status 且未 crashed → unknown，不再默认 connected（不出现假绿）', () => {
    const result = normalizeAgentStatus({ agent: 'peri' }, 'peri')
    expect(result.status).toBe('unknown')
    expect(result.status).not.toBe('connected')
    expect(result.recentError).toBeUndefined()
  })

  it('payload 缺少 status 且 crashed=true → crashed（缺失与崩溃不混淆）', () => {
    const result = normalizeAgentStatus({ agent: 'peri', crashed: true }, 'peri')
    expect(result.status).toBe('crashed')
  })

  it('空 payload 且无 fallbackAgent → unknown 且 agent 为空串', () => {
    const result = normalizeAgentStatus({})
    expect(result.status).toBe('unknown')
    expect(result.agent).toBe('')
  })

  it.each<[AgentConnectionStatus]>([
    ['connected'],
    ['connecting'],
    ['reconnecting'],
    ['disconnected'],
    ['error'],
    ['crashed'],
    ['inactive'],
  ])('合法状态 %s 原样透传', status => {
    expect(normalizeAgentStatus({ agent: 'peri', status }, 'peri').status).toBe(status)
  })

  it('status 存在时优先于 crashed（{status: connected, crashed: true} → connected），固化设计意图', () => {
    const result = normalizeAgentStatus({ agent: 'peri', status: 'connected', crashed: true }, 'peri')
    expect(result.status).toBe('connected')
  })

  it('非法字符串（如 paused）→ error，recentError 携带原始值诊断', () => {
    const result = normalizeAgentStatus({ agent: 'peri', status: 'paused' }, 'peri')
    expect(result.status).toBe('error')
    expect(result.recentError).toBe('未知 Agent 状态：paused')
  })

  it('显式下发 unknown 字符串按非法处理 → error（unknown 仅由 selector 合成，不进入 knownStatus）', () => {
    const result = normalizeAgentStatus({ agent: 'peri', status: 'unknown' }, 'peri')
    expect(result.status).toBe('error')
  })

  it('失败事件：payload.error 透传为 recentError 诊断', () => {
    const result = normalizeAgentStatus({ agent: 'peri', status: 'error', error: '心跳超时' }, 'peri')
    expect(result.status).toBe('error')
    expect(result.recentError).toBe('心跳超时')
  })
})

describe('selectAgentStatus — 单一 selector 矩阵（active 无快照→unknown；非 active→inactive；有快照→后端状态）', () => {
  const statuses: Record<string, AgentStatus> = {
    peri: { agent: 'peri', agentId: 'peri', status: 'connected', transport: 'qq' },
    hermes: { agent: 'hermes', agentId: 'hermes', status: 'error', recentError: '心跳超时' },
  }

  it('active agent 且无快照 → unknown', () => {
    expect(selectAgentStatus('peri', 'peri', {})).toMatchObject({
      agent: 'peri',
      agentId: 'peri',
      status: 'unknown',
    })
  })

  it('active agent 且有快照 → 透传后端状态（connected 及 transport）', () => {
    const result = selectAgentStatus('peri', 'peri', statuses)
    expect(result.status).toBe('connected')
    expect(result.transport).toBe('qq')
  })

  it('active agent 且有 error 快照 → 透传 error 并保留诊断', () => {
    const result = selectAgentStatus('hermes', 'hermes', statuses)
    expect(result.status).toBe('error')
    expect(result.recentError).toBe('心跳超时')
  })

  it('非 active agent → inactive，忽略其快照', () => {
    expect(selectAgentStatus('hermes', 'peri', statuses).status).toBe('inactive')
  })

  it('空 statuses 且 active → unknown（冷启动/清空后不残留旧状态）', () => {
    expect(selectAgentStatus('peri', 'peri', {}).status).toBe('unknown')
  })
})

describe('statusLabel — 全状态文案', () => {
  it.each<[AgentConnectionStatus, string]>([
    ['connected', '已连接'],
    ['connecting', '连接中'],
    ['reconnecting', '重连中'],
    ['disconnected', '未连接'],
    ['error', '错误'],
    ['crashed', '进程崩溃'],
    ['unknown', '状态未知'],
    ['inactive', '未激活'],
  ])('%s → %s', (status, label) => {
    expect(statusLabel(status)).toBe(label)
  })
})

// ── 迁移自 scripts/test-agent-contracts.mts（P91 A1）P2-01 段：capabilities 原始字段透传——normalize 只搬运不解释，不丢未知键 ──
describe('normalizeAgentStatus — capabilities 透传矩阵（P2-01，迁移自 scripts/test-agent-contracts.mts，P91 A1）', () => {
  it('capabilities 为对象：内容深相等透传（含嵌套未知键），不断言对象引用相等', () => {
    const caps = {
      promptImage: false,
      sessionClose: true,
      mcp: { http: true, sse: false },
      fork: null,
      extraUnknownKey: { nested: [1, 2, 3] },
    }
    const withCaps = normalizeAgentStatus({ agentId: 'peri', status: 'connected', capabilities: caps }, 'fallback')
    expect(withCaps.capabilities).toEqual(caps)
    expect(withCaps.agentId).toBe('peri')
    expect(withCaps.status).toBe('connected')
    expect(withCaps.agent).toBe('fallback')
  })

  it('capabilities 为 null（断线信号）：原样透传为 null，不得丢弃或替换为 {}', () => {
    expect(normalizeAgentStatus({ agentId: 'peri', status: 'disconnected', capabilities: null }).capabilities).toBeNull()
  })

  it('capabilities 缺失：结果为 undefined，不得凭空造默认值', () => {
    expect(normalizeAgentStatus({ agentId: 'peri', status: 'connected' }).capabilities).toBeUndefined()
  })

  it('未知 status 且携带 capabilities：status 归 error 并带诊断，capabilities 仍透传不丢', () => {
    const unknownStatus = normalizeAgentStatus({ agentId: 'peri', status: 'weird-status', capabilities: { promptImage: true } }, 'peri')
    expect(unknownStatus.status).toBe('error')
    expect(unknownStatus.recentError || '').toMatch(/未知 Agent 状态/)
    expect(unknownStatus.capabilities).toEqual({ promptImage: true })
  })

  it('crashed 派生路径同样保留 capabilities', () => {
    expect(normalizeAgentStatus({ agentId: 'peri', crashed: true, capabilities: null }).status).toBe('crashed')
    expect(normalizeAgentStatus({ agentId: 'peri', crashed: true, capabilities: null }).capabilities).toBeNull()
  })

  it('既有字段行为不回归：transport/cwd/error/generation/lastConnectedAt 照常搬运', () => {
    const enriched = normalizeAgentStatus(
      { agentId: 'prism', agent: 'Prism', status: 'connected', transport: 'stdio', cwd: '/tmp', error: 'boom', generation: 3, lastConnectedAt: 99, capabilities: { promptImage: true } },
      'peri',
    )
    expect(enriched.agent).toBe('Prism')
    expect(enriched.transport).toBe('stdio')
    expect(enriched.cwd).toBe('/tmp')
    expect(enriched.recentError).toBe('boom')
    expect(enriched.generation).toBe(3)
    expect(enriched.lastConnectedAt).toBe(99)
    expect(enriched.capabilities).toEqual({ promptImage: true })
  })
})

// ── 迁移自 scripts/test-agent-unknown-status.mts（P91 A1）：先查重后仅补既有矩阵未覆盖的断言
//（status 归一化、paused 诊断、selector unknown/inactive 已由上方矩阵覆盖，不再重复）。──
describe('normalizeAgentStatus — 未知状态安全处理补遗（迁移自 scripts/test-agent-unknown-status.mts，P91 A1）', () => {
  it('缺失 status：payload.agent 透传，不落 fallback', () => {
    const missingStatus = normalizeAgentStatus({ agent: 'missing-status' }, 'peri')
    expect(missingStatus.agent).toBe('missing-status')
  })

  it('legacy crashed：payload.agent 透传且无诊断', () => {
    const legacyCrashed = normalizeAgentStatus({ agent: 'legacy-crashed', crashed: true }, 'peri')
    expect(legacyCrashed.agent).toBe('legacy-crashed')
    expect(legacyCrashed.recentError).toBeUndefined()
  })

  it('非法显式 status：payload.agent 透传且不假绿', () => {
    const unknownExplicitStatus = normalizeAgentStatus({ agent: 'unknown-status', status: 'paused' }, 'peri')
    expect(unknownExplicitStatus.agent).toBe('unknown-status')
  })

  it('非法 status 且带上游 error：status 归 error（不假绿），诊断优先透传上游 error', () => {
    const unknownStatusWithDiagnostic = normalizeAgentStatus({
      agent: 'unknown-with-error',
      status: 'future-status',
      error: '上游返回了未识别状态',
    }, 'peri')
    expect(unknownStatusWithDiagnostic.status).toBe('error')
    expect(unknownStatusWithDiagnostic.status).not.toBe('connected')
    expect(unknownStatusWithDiagnostic.recentError).toBe('上游返回了未识别状态')
  })

  it('payload 缺 agent：回填 fallbackAgent，诊断携带原始 status', () => {
    const fallbackAgentStatus = normalizeAgentStatus({ status: 'mystery' }, 'peri')
    expect(fallbackAgentStatus.agent).toBe('peri')
    expect(fallbackAgentStatus.status).toBe('error')
    expect(fallbackAgentStatus.recentError || '').toMatch(/未知 Agent 状态：mystery/)
  })
})

// ── 迁移自 scripts/test-agent-status-transaction.mts（P91 A1）：normalize/statusLabel 纯函数断言
//（App/Settings/runtimeStore 源码 include 段按处置不迁；重连事务部分见 agentState.test.ts）。──
describe('normalizeAgentStatus/statusLabel — transaction 矩阵（迁移自 scripts/test-agent-status-transaction.mts，P91 A1）', () => {
  it('状态归一：crashed/reconnecting/connecting/inactive 透传；connected 优先于 crashed；unknown 归 error 带诊断', () => {
    expect(normalizeAgentStatus({ crashed: true }, 'peri').status).toBe('crashed')
    expect(normalizeAgentStatus({ status: 'reconnecting' }, 'peri').status).toBe('reconnecting')
    expect(normalizeAgentStatus({ status: 'connecting' }, 'peri').status).toBe('connecting')
    expect(normalizeAgentStatus({ status: 'inactive' }, 'peri').status).toBe('inactive')
    expect(normalizeAgentStatus({ status: 'unknown' }, 'peri').status).toBe('error')
    expect(normalizeAgentStatus({ status: 'unknown' }, 'peri').recentError || '').toMatch(/未知 Agent 状态/)
    expect(normalizeAgentStatus({ status: 'connected', crashed: true }, 'peri').status).toBe('connected')
  })

  it('enriched 字段照常搬运', () => {
    const enriched = normalizeAgentStatus({ agentId: 'prism', agent: 'Prism', status: 'connected', generation: 7, lastConnectedAt: 1234 }, 'peri')
    expect(enriched.agentId).toBe('prism')
    expect(enriched.agent).toBe('Prism')
    expect(enriched.generation).toBe(7)
    expect(enriched.lastConnectedAt).toBe(1234)
  })

  it('statusLabel 文案', () => {
    expect(statusLabel('connecting')).toBe('连接中')
    expect(statusLabel('inactive')).toBe('未激活')
    expect(statusLabel('reconnecting')).toBe('重连中')
  })
})
