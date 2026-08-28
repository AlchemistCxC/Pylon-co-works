import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { VISUAL_SEMANTIC_ROLE_TOKENS, VISUAL_SEMANTIC_TOKENS } from '../visualSemantics.ts'
import { selectThemeCssSnapshot } from '../themeCssSnapshot.ts'

const LAYOUT = { sidebarCollapsed: false, sidebarWidth: 250, sidebarEnabled: true }

function css(relativePath: string): string {
  const pathname = decodeURIComponent(new URL(relativePath, import.meta.url).pathname)
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

  it('defines all mode/scheme fallback selectors in the host stylesheet', () => {
    const styles = css('../../../index.css')
    for (const mode of ['terminal-like', 'modern-gui']) {
      for (const scheme of ['dark', 'light']) {
        expect(styles).toContain(`data-interface-mode="${mode}"`)
        expect(styles).toContain(`data-ui-scheme="${scheme}"`)
      }
    }
    expect(styles).toContain('--content-text: var(--pylon-palette-content-text)')
    expect(styles).toContain('--connector-default: var(--pylon-palette-connector-default)')
  })
})
