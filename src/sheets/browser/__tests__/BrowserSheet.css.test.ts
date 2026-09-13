import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// 绞杀 P93 批 4：BrowserSheet.css 已删除，地址栏焦点契约迁移为
// BrowserSheetView 上的 utilities。本测试锁定契约在新载体的表达。
const tsx = readFileSync('src/sheets/browser/BrowserSheetView.tsx', 'utf8')

describe('browser address focus visual contract', () => {
  it('keeps focus feedback inset without an external glow or layout expansion', () => {
    const wrapLine = tsx.split('\n').find(line => line.includes('browser-address-wrap')) ?? ''
    expect(wrapLine).toContain('focus-within:border-border-focus')
    expect(wrapLine).toContain('focus-within:shadow-[inset_0_-2px_0_var(--accent)]')
    expect(wrapLine).not.toMatch(/0 0 0 2px/)

    const addressLine = tsx.split('\n').find(line => line.includes('browser-address ')) ?? ''
    expect(addressLine).toContain('focus-visible:outline-[var(--state-focus-ring)]')
    expect(addressLine).toContain('focus-visible:outline-offset-[-1px]')
  })
})
