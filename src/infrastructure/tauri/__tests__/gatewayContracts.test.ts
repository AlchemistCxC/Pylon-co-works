/**
 * ISSUE-12 W6（LR2-WI01）：route typed contract 与严格 fixture。
 *
 * 后端 wire 契约（route.rs 手写 Serialize，golden 测试
 * binding_serializes_with_camel_case_wire_contract 钉死）：route 必须携带
 * source/agentId/profileId/sessionKey/instanceId/allowFrom/reset/idleMinutes
 * 八字段（camelCase）。前端 normalizeGatewayStatus 是这条链的第一环——丢弃
 * instanceId 会让「normalize 后整体回写」静默清空所有实例绑定（ISSUE-12 问题 1）。
 */
import { describe, expect, it } from 'vitest'
import { normalizeGatewayStatus, type GatewayRoute } from '../gatewayContracts'

const FULL_WIRE_ROUTE = {
  source: 'qq:group:123',
  agentId: 'peri',
  profileId: 'trpg',
  sessionKey: '战役1',
  instanceId: 'qq-bot-1',
  allowFrom: ['member-1', 'member-2'],
  reset: 'daily',
  idleMinutes: 60,
}

describe('normalizeGatewayStatus route strict fixture（I12 W6）', () => {
  it('RED（修复前）：完整后端 wire 形状必须 8 字段逐一保留（instanceId 不得被丢弃）', () => {
    const status = normalizeGatewayStatus({
      adapters: ['qq'],
      routes: [FULL_WIRE_ROUTE],
      qq: null,
      inject: null,
    })
    const route = status.routes[0] as GatewayRoute
    expect(route).toEqual({
      source: 'qq:group:123',
      agentId: 'peri',
      profileId: 'trpg',
      sessionKey: '战役1',
      instanceId: 'qq-bot-1',
      allowFrom: ['member-1', 'member-2'],
      reset: 'daily',
      idleMinutes: 60,
    })
  })

  it('legacy 路由（无 instanceId）→ 不产出 instanceId 字段（宽容 normalize 保留）', () => {
    const status = normalizeGatewayStatus({
      adapters: ['qq'],
      routes: [{ source: 'qq:user:456', agentId: 'hermes', profileId: 'default', sessionKey: 'dm' }],
      qq: null,
      inject: null,
    })
    const route = status.routes[0] as GatewayRoute
    expect('instanceId' in route).toBe(false)
    expect(route.reset).toBe('idle')
  })

  it('reset 非法值 → idle 兜底（联合类型契约）', () => {
    const status = normalizeGatewayStatus({
      adapters: [],
      routes: [{ source: 'qq:group:1', agentId: 'peri', reset: 'session' }],
      qq: null,
      inject: null,
    })
    expect(status.routes[0].reset).toBe('idle')
  })

  it('unboundPolicy（I12 W9）宽容 normalize：合法值透传、非法/缺失缺省', () => {
    expect(normalizeGatewayStatus({ adapters: [], routes: [], qq: null, inject: null, unboundPolicy: 'reject' }).unboundPolicy).toBe('reject')
    expect(normalizeGatewayStatus({ adapters: [], routes: [], qq: null, inject: null, unboundPolicy: 'active-agent' }).unboundPolicy).toBe('active-agent')
    expect(normalizeGatewayStatus({ adapters: [], routes: [], qq: null, inject: null, unboundPolicy: 'silent' }).unboundPolicy).toBeUndefined()
    expect(normalizeGatewayStatus({ adapters: [], routes: [], qq: null, inject: null }).unboundPolicy).toBeUndefined()
  })
})
