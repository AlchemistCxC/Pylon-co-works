import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { VISUAL_SEMANTIC_ROLE_TOKENS } from '../visualSemantics.ts'

const INDEX_CSS_PATH = new URL('../../../index.css', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const INDEX_CSS = readFileSync(INDEX_CSS_PATH, 'utf8')

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

/** 区块化取块：从 startMarker 起按大括号配平截取完整规则块（支持 @media 嵌套） */
function blockContaining(cssText: string, startMarker: string): string {
  const start = cssText.indexOf(startMarker)
  if (start < 0) throw new Error(`缺少 ${startMarker}`)
  const open = cssText.indexOf('{', start)
  if (open < 0) throw new Error(`区块无开括号：${startMarker}`)
  let depth = 0
  for (let i = open; i < cssText.length; i++) {
    if (cssText[i] === '{') depth++
    else if (cssText[i] === '}') {
      depth--
      if (depth === 0) return cssText.slice(start, i + 1)
    }
  }
  throw new Error(`区块未闭合：${startMarker}`)
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

  it('keeps host focus and reduced-motion guardrails tokenized（断言锚定到具体规则区块）', () => {
    // 键盘焦点区块：完整 :where(...) 选择器 + token 化的 outline/offset 都在同一区块内
    const focusBlock = blockContaining(INDEX_CSS, ':where(button, [role="button"], [role="tab"], [role="option"], [role="treeitem"], a, input, textarea, select):focus-visible')
    expect(focusBlock).toContain(':where(button, [role="button"], [role="tab"], [role="option"], [role="treeitem"], a, input, textarea, select):focus-visible')
    expect(focusBlock).toContain('outline: 2px solid var(--accent)')
    expect(focusBlock).toContain('outline-offset: 2px')
    // 禁用态区块：disabled/aria-disabled 命中同一 token 化 opacity
    const disabledBlock = blockContaining(INDEX_CSS, ':where(button, input, textarea, select):disabled')
    expect(disabledBlock).toContain('opacity: var(--state-disabled-opacity)')
    // reduced-motion 媒体区块：token 降速 + 强制时长都在区块内
    const reducedMotionBlock = blockContaining(INDEX_CSS, '@media (prefers-reduced-motion: reduce)')
    expect(reducedMotionBlock).toContain('--motion-standard: 1ms')
    expect(reducedMotionBlock).toContain('animation-duration:1ms !important')
    expect(reducedMotionBlock).toContain('transition-duration:1ms !important')
  })
})
