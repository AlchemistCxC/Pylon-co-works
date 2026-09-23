// 迁移自 scripts/test-custom-preset-id.mts + scripts/test-custom-presets.mts（P91 A1）。
// 两脚本合并；原为线性脚本，fixture 沿用原语句顺序在 describe 体中构建一次
// （customPresets.ts 模块级 generatedCustomPresetIds 随构建顺序累积，时间戳互不重复）。
import { describe, expect, it } from 'vitest'
import {
  createCustomPreset,
  createCustomPresetId,
  deleteCustomPreset,
  normalizeCustomPresets,
  pickCustomPresetTheme,
  upsertCustomPreset,
} from '../customPresets.ts'

describe('custom preset ID / theme whitelist（原 test-custom-preset-id.mts）', () => {
  const theme = { globalBgColor: '#123456' }
  const first = createCustomPreset('first', theme, 1000)
  const second = createCustomPreset('second', theme, 1000)
  const explicitTimes = [
    createCustomPreset('at 3000', theme, 3000),
    createCustomPreset('at 4000', theme, 4000),
  ]
  const updated = { ...first, name: 'updated', updatedAt: 1001 }
  const upserted = upsertCustomPreset([first, second], updated)
  const pickedTheme = pickCustomPresetTheme({
    globalBgColor: '#abcdef',
    ccBgImage: 'url(fixture.png)',
    appliedPreset: { global: 'stale' },
    custom: { global: true },
    ccEditMode: true,
    customPresets: [],
    callback: () => 'ignored',
  })

  it('id 唯一：同秒创建递增后缀', () => {
    expect(first.id).not.toBe(second.id)
    expect(first.id).toBe('custom-1000')
    expect(second.id).toBe('custom-1000-1')
  })

  it('createCustomPresetId：占用时递增后缀避让', () => {
    expect(createCustomPresetId(2000)).toBe('custom-2000')
    expect(createCustomPresetId(2000, ['custom-2000'])).toBe('custom-2000-1')
    expect(createCustomPresetId(2000, ['custom-2000', 'custom-2000-1'])).toBe('custom-2000-2')
  })

  it('显式时间戳直接构成 id', () => {
    expect(explicitTimes[0].id).toBe('custom-3000')
    expect(explicitTimes[1].id).toBe('custom-4000')
  })

  it('upsert 覆盖同 id 项，delete 按 id 移除', () => {
    expect(upserted.map(preset => preset.id)).toEqual([first.id, second.id])
    expect(upserted[0].name).toBe('updated')
    expect(deleteCustomPreset(upserted, first.id).map(preset => preset.id)).toEqual([second.id])
  })

  it('pickCustomPresetTheme 仅保留白名单键', () => {
    expect(pickedTheme).toEqual({ globalBgColor: '#abcdef', ccBgImage: 'url(fixture.png)' })
  })
})

describe('customPresets CRUD 与业务键隔离（原 test-custom-presets.mts）', () => {
  const theme = { globalBgColor: '#123456', spinnerSize: 18 }
  const first = createCustomPreset('  夜航  ', theme, 100)
  const saved = upsertCustomPreset([], first)
  const overwritten = upsertCustomPreset(saved, { ...first, theme: { globalBgColor: '#000000' }, updatedAt: 200 })
  const normalized = normalizeCustomPresets([{ id: '', name: '', theme: null }, first] as never)

  const runtimeFunction = () => 'transient'
  const mixedState = {
    transparency: 0.72,
    globalFont: 'mono',
    bgBlur: 12,
    barFillFollow: true,
    spinnerSize: 18,
    // ★ 刀7：`ccScale` 已从主题字段表移除 ⇒ 与 barFillFollow 同样被白名单挡掉（样本保留，判据反转）
    ccScale: { tokens: 95 },
    appliedPreset: { global: 'glass' },
    custom: { global: true },
    ccEditMode: true,
    customPresets: [first],
    profiles: [{ id: 'profile-1' }],
    sessions: [{ id: 'session-1' }],
    users: [{ id: 'user-1' }],
    runtime: { generating: true },
    unknownField: 'must not leak',
    runtimeFunction,
  }
  const picked = pickCustomPresetTheme(mixedState)
  const savedMixedPreset = createCustomPreset('混合状态', picked, 300)

  it('create：名称 trim、id、theme 深拷贝', () => {
    expect(first.name).toBe('夜航')
    expect(first.id).toBe('custom-100')
    expect(first.theme).toEqual(theme)
  })

  it('upsert：同 id 覆盖不新增', () => {
    expect(saved.length).toBe(1)
    expect(overwritten.length).toBe(1)
    expect(overwritten[0].theme.globalBgColor).toBe('#000000')
    expect(overwritten[0].updatedAt).toBe(200)
  })

  it('delete：清空列表', () => {
    expect(deleteCustomPreset(overwritten, first.id)).toEqual([])
  })

  it('normalize：剔除空条目，legacy 主题适配为 v2 bundle', () => {
    expect(normalized.length).toBe(1)
    expect(normalized[0]).toEqual({ ...first, bundle: {
      manifestVersion: 2,
      id: 'custom-100',
      name: '夜航',
      source: 'user',
      createdAt: 100,
      updatedAt: 100,
      contributions: {
        'builtin.theme': {
          ownerPluginId: 'builtin.pylon-shell',
          providerVersion: 1,
          policy: 'complete',
          payload: theme,
        },
      },
    } })
  })

  it('空名称抛错', () => {
    expect(() => createCustomPreset('   ', theme, 100)).toThrow(/名称/)
  })

  it('pickCustomPresetTheme：业务键与运行时/未知字段不泄漏', () => {
    expect(picked).toEqual({
      transparency: 0.72,
      globalFont: 'mono',
      bgBlur: 12,
      spinnerSize: 18,
    })
    // 刀4：barFillFollow 已从主题字段表移除 → 与未知字段同样被白名单挡掉
    expect('barFillFollow' in picked).toBe(false)
    // 刀7：ccScale 同理（用户口径「我预期里没有缩放这一项」；整字段删除，不留残留键）
    expect('ccScale' in picked).toBe(false)
    expect('appliedPreset' in picked).toBe(false)
    expect('custom' in picked).toBe(false)
    expect('ccEditMode' in picked).toBe(false)
    expect('customPresets' in picked).toBe(false)
    expect('profiles' in picked).toBe(false)
    expect('sessions' in picked).toBe(false)
    expect('users' in picked).toBe(false)
    expect('runtime' in picked).toBe(false)
    expect('runtimeFunction' in picked).toBe(false)
    expect('unknownField' in picked).toBe(false)
  })

  it('用 picked theme 建预设不携带非白名单键', () => {
    expect(savedMixedPreset.theme).toEqual(picked)
    expect('profiles' in savedMixedPreset.theme).toBe(false)
    expect('sessions' in savedMixedPreset.theme).toBe(false)
    expect('users' in savedMixedPreset.theme).toBe(false)
    expect('runtime' in savedMixedPreset.theme).toBe(false)
    expect('customPresets' in savedMixedPreset.theme).toBe(false)
    expect('appliedPreset' in savedMixedPreset.theme).toBe(false)
    expect('custom' in savedMixedPreset.theme).toBe(false)
    expect('ccEditMode' in savedMixedPreset.theme).toBe(false)
  })
})
