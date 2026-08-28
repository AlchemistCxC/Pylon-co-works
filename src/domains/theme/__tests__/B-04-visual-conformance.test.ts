import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { VISUAL_SEMANTIC_ROLE_TOKENS } from '../visualSemantics.ts'

const INDEX_CSS = readFileSync(new URL('../../../index.css', import.meta.url), 'utf8')

type Rgb = readonly [number, number, number]

function parseHex(value: string): Rgb | undefined {
  const hex = value.trim().match(/^#([\da-f]{6})$/i)?.[1]
  if (!hex) return undefined
  return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)]
}

function luminance(rgb: Rgb): number {
  const channels = rgb.map(channel => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

function contrast(foreground: Rgb, background: Rgb): number {
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function roleValue(block: string, role: string): Rgb {
  const token = `--pylon-palette-${VISUAL_SEMANTIC_ROLE_TOKENS[role as keyof typeof VISUAL_SEMANTIC_ROLE_TOKENS].slice(2)}`
  const value = block.match(new RegExp(`${token}:\\s*(#[\\da-f]{6})`, 'i'))?.[1]
  const parsed = value ? parseHex(value) : undefined
  if (!parsed) throw new Error(`缺少 ${token}`)
  return parsed
}

function paletteBlock(mode: string, scheme: string): string {
  const selector = `[data-interface-mode="${mode}"][data-ui-scheme="${scheme}"]`
  const start = INDEX_CSS.indexOf(selector)
  if (start < 0) throw new Error(`缺少 ${selector}`)
  const end = INDEX_CSS.indexOf('}', start)
  if (end < 0) throw new Error(`selector 未闭合：${selector}`)
  return INDEX_CSS.slice(start, end)
}

describe('B-04 visual conformance invariants', () => {
  it.each([
    ['terminal-like', 'dark'],
    ['terminal-like', 'light'],
    ['modern-gui', 'dark'],
    ['modern-gui', 'light'],
  ])('%s/%s fallback roles meet WCAG contrast floors', (mode, scheme) => {
    const block = paletteBlock(mode, scheme)
    const canvas = roleValue(block, 'surface.canvas')
    const text = roleValue(block, 'content.text')
    const muted = roleValue(block, 'content.muted')
    const stroke = roleValue(block, 'stroke.default')
    const accent = roleValue(block, 'accent')
    const success = roleValue(block, 'state.success')
    const warning = roleValue(block, 'state.warning')
    const danger = roleValue(block, 'state.danger')
    const focusRing = roleValue(block, 'state.focusRing')
    const connector = roleValue(block, 'connector.default')

    expect(contrast(text, canvas)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(muted, canvas)).toBeGreaterThanOrEqual(4.5)
    for (const foreground of [stroke, accent, success, warning, danger, focusRing, connector]) {
      expect(contrast(foreground, canvas)).toBeGreaterThanOrEqual(3)
    }
  })

  it('keeps host focus and reduced-motion guardrails tokenized', () => {
    expect(INDEX_CSS).toContain(':where(button, [role="button"], [role="tab"], [role="option"], [role="treeitem"], a, input, textarea, select):focus-visible')
    expect(INDEX_CSS).toContain('outline: 2px solid var(--accent)')
    expect(INDEX_CSS).toContain('outline-offset: 2px')
    expect(INDEX_CSS).toContain('opacity: var(--state-disabled-opacity)')
    expect(INDEX_CSS).toContain('@media (prefers-reduced-motion: reduce)')
    expect(INDEX_CSS).toContain('--motion-standard: 1ms')
    expect(INDEX_CSS).toContain('animation-duration:1ms !important')
    expect(INDEX_CSS).toContain('transition-duration:1ms !important')
  })
})
