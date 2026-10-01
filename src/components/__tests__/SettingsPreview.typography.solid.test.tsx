// @vitest-environment jsdom
// #515：迁移自 SettingsPreview.typography.test.tsx（React RTL → Solid 实体直连；
// 断言集原样保留，无改写点）。
import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import SettingsPreview from '../SettingsPreview.solid.tsx'

afterEach(cleanup)

describe('SettingsPreview tool typography', () => {
  it('keeps tool names as prose and marks path/command summaries as code', () => {
    const { container } = render(() => <SettingsPreview zone="global" />)

    const names = [...container.querySelectorAll('.pv-tool-row .term-tool-name')]
    expect(names.map(node => node.textContent)).toEqual(['Read', 'Bash', 'Edit'])
    expect(names.every(node => !node.classList.contains('term-tool-summary-code'))).toBe(true)

    const summaries = [...container.querySelectorAll('.pv-tool-row .term-tool-summary')]
    expect(summaries).toHaveLength(3)
    expect(summaries.every(node => node.classList.contains('term-tool-summary-code'))).toBe(true)
  })
})
