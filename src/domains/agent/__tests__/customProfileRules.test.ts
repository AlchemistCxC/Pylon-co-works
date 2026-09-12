import { describe, expect, it } from 'vitest'
import {
  assertCustomProfileFieldsAllowed,
  CUSTOM_PROFILE_FIELD_WHITELIST,
  isValidAgentIdPattern,
  validateCustomProfile,
} from '../customProfileRules.ts'
import { builtinAgentCatalog } from '../agentCatalog.ts'

describe('customProfileRules', () => {
  const builtins = builtinAgentCatalog.providers()

  it('合法输入零 issue', () => {
    expect(validateCustomProfile(
      { id: 'my-agent', name: 'My Agent', exe: 'agent.exe', provider: 'custom' },
      ['peri'],
      builtins,
    )).toEqual([])
  })

  it('slug 校验与后端同一正则', () => {
    expect(isValidAgentIdPattern('a')).toBe(true)
    expect(isValidAgentIdPattern('A.b_c-1')).toBe(true)
    expect(isValidAgentIdPattern('-bad')).toBe(false)
    expect(isValidAgentIdPattern('')).toBe(false)
    expect(isValidAgentIdPattern('带空格 id')).toBe(false)
    const issues = validateCustomProfile(
      { id: '-bad', name: 'n', exe: 'e', provider: 'custom' },
      [],
      builtins,
    )
    expect(issues.some(issue => issue.code === 'invalid_id')).toBe(true)
  })

  it('重复 id 拒绝（新建不可覆盖）', () => {
    const issues = validateCustomProfile(
      { id: 'peri', name: 'n', exe: 'peri', provider: 'peri' },
      ['peri'],
      builtins,
    )
    expect(issues.some(issue => issue.code === 'duplicate_id')).toBe(true)
  })

  it('内置 id 冲突：id 借用内置 provider 名而 provider 另指他处', () => {
    // id=peri 且 provider=peri：导入内置 provider 的正常路径，不触发。
    expect(validateCustomProfile(
      { id: 'peri', name: 'Peri', exe: 'peri', provider: 'peri' },
      [],
      builtins,
    )).toEqual([])
    // id=peri 但 provider=hermes：身份说明自相矛盾，拒绝。
    const issues = validateCustomProfile(
      { id: 'peri', name: 'Peri', exe: 'some.exe', provider: 'hermes' },
      [],
      builtins,
    )
    const conflict = issues.find(issue => issue.code === 'builtin_id_conflict')
    expect(conflict).toBeDefined()
    expect(conflict?.message).toContain('内置 provider 同名')
    // id 与内置同名但 provider 为空（未声明）：不算冒用，由其他规则处理。
    const undeclared = validateCustomProfile(
      { id: 'peri', name: 'Peri', exe: 'some.exe', provider: '' },
      [],
      builtins,
    )
    expect(undeclared.some(issue => issue.code === 'builtin_id_conflict')).toBe(false)
  })

  it('必填 launch：name 与 exe 缺一不可', () => {
    const issues = validateCustomProfile(
      { id: 'ok-id', name: '  ', exe: '', provider: 'custom' },
      [],
      builtins,
    )
    expect(issues.some(issue => issue.code === 'missing_name')).toBe(true)
    expect(issues.some(issue => issue.code === 'missing_exe')).toBe(true)
  })

  it('字段封闭：白名单之外的键在构造期即抛错', () => {
    expect(() => assertCustomProfileFieldsAllowed({
      name: 'n', provider: 'custom', transport: 'subprocess', exe: 'e', args: [], default: false,
    })).not.toThrow()
    expect(() => assertCustomProfileFieldsAllowed({ mcpServers: [] } as Record<string, unknown>)).toThrow(
      /未知字段/,
    )
    expect(CUSTOM_PROFILE_FIELD_WHITELIST).not.toContain('mcpServers')
  })
})
