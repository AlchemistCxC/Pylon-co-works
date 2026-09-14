import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { VISUAL_SEMANTIC_ROLE_TOKENS, VISUAL_SEMANTIC_TOKENS } from '../visualSemantics.ts'
import { selectThemeCssSnapshot } from '../themeCssSnapshot.ts'

const LAYOUT = { sidebarCollapsed: false, sidebarWidth: 250, sidebarEnabled: true }

/** 区块解析（复用 B-04 先例）：按 selector 定位并按大括号配平截取完整规则块 */
function selectorBlock(cssText: string, selector: string): string {
  const start = cssText.indexOf(selector)
  if (start < 0) throw new Error(`缺少 ${selector}`)
  const end = cssText.indexOf('}', start)
  if (end < 0) throw new Error(`selector 未闭合：${selector}`)
  return cssText.slice(start, end)
}

function indexCss(): string {
  const pathname = decodeURIComponent(new URL('../../../index.css', import.meta.url).pathname)
    .replace(/^\/([A-Za-z]:)/, '$1')
  return readFileSync(pathname, 'utf8')
}

describe('B-01 host semantic palette projection', () => {
  it('publishes the frozen role names through the existing semantic token object', () => {
    expect(VISUAL_SEMANTIC_ROLE_TOKENS['surface.canvas']).toBe(VISUAL_SEMANTIC_TOKENS.surface.canvas)
    expect(VISUAL_SEMANTIC_ROLE_TOKENS['content.text']).toBe(VISUAL_SEMANTIC_TOKENS.content.text)
    expect(VISUAL_SEMANTIC_ROLE_TOKENS['content.muted']).toBe(VISUAL_SEMANTIC_TOKENS.content.muted)
    expect(VISUAL_SEMANTIC_ROLE_TOKENS['stroke.default']).toBe(VISUAL_SEMANTIC_TOKENS.stroke.default)
    expect(VISUAL_SEMANTIC_ROLE_TOKENS['state.success']).toBe(VISUAL_SEMANTIC_TOKENS.state.success)
    expect(VISUAL_SEMANTIC_ROLE_TOKENS['state.warning']).toBe(VISUAL_SEMANTIC_TOKENS.state.warning)
    expect(VISUAL_SEMANTIC_ROLE_TOKENS['state.danger']).toBe(VISUAL_SEMANTIC_TOKENS.state.danger)
    expect(VISUAL_SEMANTIC_ROLE_TOKENS['state.focusRing']).toBe(VISUAL_SEMANTIC_TOKENS.state.focusRing)
    expect(VISUAL_SEMANTIC_ROLE_TOKENS['connector.default']).toBe(VISUAL_SEMANTIC_TOKENS.connector.default)
  })

  it('projects missing roles to mode/scheme fallback variables without a parallel resolver', () => {
    const vars = selectThemeCssSnapshot({ uiScheme: 'light' }, LAYOUT)
    expect(vars['--surface-canvas']).toBe('var(--pylon-palette-surface-canvas)')
    expect(vars['--surface-panel']).toBe('var(--pylon-palette-surface-panel)')
    expect(vars['--surface-raised']).toBe('var(--pylon-palette-surface-raised)')
    expect(vars['--content-text']).toBe('var(--pylon-palette-content-text)')
    expect(vars['--content-muted']).toBe('var(--pylon-palette-content-muted)')
    expect(vars['--stroke-default']).toBe('var(--pylon-palette-stroke-default)')
    expect(vars['--state-success']).toBe('var(--pylon-palette-state-success)')
    expect(vars['--state-warning']).toBe('var(--pylon-palette-state-warning)')
    expect(vars['--state-danger']).toBe('var(--pylon-palette-state-danger)')
    expect(vars['--state-focus-ring']).toBe('var(--pylon-palette-state-focus-ring)')
    expect(vars['--connector-default']).toBe('var(--pylon-palette-connector-default)')
  })

  it('keeps explicit preset role candidates and legacy aliases on the same projection', () => {
    const vars = selectThemeCssSnapshot({
      uiScheme: 'dark',
      globalBgColor: 'var(--preset-canvas)',
      chatTextColor: 'var(--preset-text)',
      toolOk: 'var(--preset-success)',
      toolErr: 'var(--preset-danger)',
      toolConnectorColor: 'var(--preset-connector)',
    }, LAYOUT)

    expect(vars['--surface-canvas']).toBe('var(--preset-canvas)')
    expect(vars['--content-text']).toBe('var(--preset-text)')
    expect(vars['--state-success']).toBe('var(--preset-success)')
    expect(vars['--state-danger']).toBe('var(--preset-danger)')
    expect(vars['--connector-default']).toBe('var(--preset-connector)')
    expect(vars['--global-bg-color']).toBe(vars['--surface-canvas'])
    expect(vars['--text']).toBe(vars['--content-text'])
    expect(vars['--tool-ok']).toBe(vars['--state-success'])
    expect(vars['--tool-err']).toBe(vars['--state-danger'])
  })

  it('falls back only the role whose explicit value fails the scheme probe', () => {
    const vars = selectThemeCssSnapshot({
      uiScheme: 'light',
      chatTextColor: '#FFFFFF',
      toolOk: 'var(--preset-success)',
    }, LAYOUT)

    expect(vars['--content-text']).toBe('var(--pylon-palette-content-text)')
    expect(vars['--state-success']).toBe('var(--preset-success)')
  })

  it('defines all mode/scheme fallback selectors in the host stylesheet（区块解析）', () => {
    const styles = indexCss()
    for (const mode of ['terminal-like', 'modern-gui']) {
      for (const scheme of ['dark', 'light']) {
        // 每个 mode/scheme 的 fallback palette 区块都存在且真的携带 palette token
        const block = selectorBlock(styles, `[data-interface-mode="${mode}"][data-ui-scheme="${scheme}"]`)
        expect(block).toContain('--pylon-palette-content-text: #')
        expect(block).toContain('--pylon-palette-connector-default: #')
      }
    }
    // 角色投影集中在 mode/scheme 无关的通配区块内
    const projectionBlock = selectorBlock(styles, ':where(html, body, .app)[data-interface-mode][data-ui-scheme]')
    expect(projectionBlock).toContain('--content-text: var(--pylon-palette-content-text)')
    expect(projectionBlock).toContain('--connector-default: var(--pylon-palette-connector-default)')
  })
})
