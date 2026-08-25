// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULTS } from '../../../domains/theme/themeDefaults.ts'
import { ZoneGroupFields } from '../../../themeFieldRenderer.tsx'
import { getPluginSettingOptionsRegistry } from '../../runtimeServices.ts'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import type { AsyncDisposable } from '../../registry/types.ts'

const registrations: AsyncDisposable[] = []

afterEach(async () => {
  while (registrations.length > 0) await registrations.pop()?.dispose()
})

describe('Settings option contribution rendering', () => {
  it('在宿主候选控件中反映删除、修改和新增，且保留已失效当前值', () => {
    registrations.push(getPluginSettingOptionsRegistry().register(createPluginIdentity('test.settings', 'select'), {
      id: 'test.settings.msg-style', target: 'theme.msgStyle',
      remove: ['terminal'],
      upsert: [{ value: 'bubble', label: '插件气泡' }, { value: 'cards', label: '插件卡片' }],
    }))
    render(<ZoneGroupFields zone="chat" ctx={{ t: { ...DEFAULTS }, onChange: () => {} }} />)

    expect(screen.getByRole('radiogroup', { name: '消息风格' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'terminal（已不可用）' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: '插件气泡' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '插件卡片' })).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: '终端记录流' })).not.toBeInTheDocument()
  })

  it('仅在目标颜色字段中展示插件色板', () => {
    registrations.push(getPluginSettingOptionsRegistry().register(createPluginIdentity('test.settings', 'color'), {
      id: 'test.settings.accent', target: 'theme.accent',
      upsert: [{ value: '#7c3aed', label: '插件紫' }],
    }))
    render(<ZoneGroupFields zone="global" ctx={{ t: { ...DEFAULTS }, onChange: () => {} }} />)

    fireEvent.click(screen.getByRole('button', { name: '打开颜色选择器' }))
    expect(screen.getByRole('button', { name: '选择颜色 插件紫' })).toBeInTheDocument()
  })
})
