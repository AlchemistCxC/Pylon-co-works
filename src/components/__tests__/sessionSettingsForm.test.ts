import { describe, expect, it } from 'vitest'
import { createSessionSettingsValues, isSessionSettingsDirty } from '../sessionSettingsForm.ts'

// 下沉自 scripts/test-session-settings-form.mts（P91 A2）：表单值工厂与 dirty 判定。
describe('sessionSettingsForm 值工厂与 dirty 判定', () => {
  it('createSessionSettingsValues 从会话取值', () => {
    const initial = createSessionSettingsValues({
      name: 'A',
      platform: 'local',
      workdir: 'G:/Work/A',
      sessionPrompt: '保持简洁',
    })
    expect(initial).toEqual({
      name: 'A',
      platform: 'local',
      workdir: 'G:/Work/A',
      sessionPrompt: '保持简洁',
    })
  })

  it('初始值不 dirty；任一字段变化即 dirty', () => {
    const initial = createSessionSettingsValues({ name: 'A', platform: 'local', workdir: 'G:/Work/A', sessionPrompt: '保持简洁' })
    expect(isSessionSettingsDirty(initial, initial)).toBe(false)
    expect(isSessionSettingsDirty({ ...initial, workdir: 'G:/Work/B' }, initial)).toBe(true)
  })

  it('缺省会话给安全默认值', () => {
    expect(createSessionSettingsValues()).toEqual({
      name: '',
      platform: 'local',
      workdir: '',
      sessionPrompt: '',
    })
  })
})
