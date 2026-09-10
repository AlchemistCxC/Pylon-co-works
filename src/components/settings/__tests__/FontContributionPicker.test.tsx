// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import FontContributionPicker from '../FontContributionPicker.tsx'

describe('FontContributionPicker role-safe preview', () => {
  it('previews the code fallback when the selected contribution is unavailable', () => {
    const result = render(<FontContributionPicker
      value="vendor.missing-code"
      role="code"
      ariaLabel="代码与路径字体"
      settingTarget="theme.codeFont"
      onChange={() => {}}
    />)

    expect(result.container.querySelector<HTMLElement>('.font-contribution-sample')?.style.fontFamily).toBe('var(--mono)')
  })

  it('keeps interface/content unavailable previews inheriting the UI face', () => {
    const result = render(<FontContributionPicker
      value="vendor.missing-ui"
      role="interface"
      ariaLabel="界面字体"
      settingTarget="theme.globalFont"
      onChange={() => {}}
    />)

    expect(result.container.querySelector<HTMLElement>('.font-contribution-sample')?.style.fontFamily).toBe('inherit')
  })
})
