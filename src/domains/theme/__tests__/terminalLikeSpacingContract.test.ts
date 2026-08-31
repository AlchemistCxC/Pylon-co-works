import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { presentationProfileInterfaceMode } from '../../../application/transactions/activateInterfaceMode.ts'
import { BUILTIN_PRESENTATION_PROFILES } from '../../../plugins/core/renderer/builtinPresentationProfiles.ts'

const chatCss = readFileSync('src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css', 'utf8')

describe('terminal-like 块间距 contract', () => {
  it('uses one explicit cadence token set at the terminal-like boundary', () => {
    expect(chatCss).toMatch(/\.app\[data-interface-mode="terminal-like"\] \.term\s*\{[^}]*--chat-row-gap:\s*8px/)
    expect(chatCss).toMatch(/\.app\[data-interface-mode="terminal-like"\] \.term\s*\{[^}]*--chat-tool-gap:\s*4px/)
    expect(chatCss).toMatch(/\.app\[data-interface-mode="terminal-like"\] \.term\s*\{[^}]*--chat-activity-gap:\s*6px/)
  })

  it('assigns Solid inter-row spacing to the wrapper, not the message body', () => {
    expect(chatCss).toMatch(/\.app\[data-interface-mode="terminal-like"\] \.plain-message-list__row \+ \.plain-message-list__row\s*\{[^}]*padding-block-start:\s*var\(--chat-row-gap\)/)
    expect(chatCss).toMatch(/\.term-plain-text\s*\{[^}]*line-height:inherit/)
  })

  it('keeps the shared row/tool cadence available to the Solid workbench', () => {
    expect(chatCss).toMatch(/\.term-row \+ \.term-row\s*\{[^}]*margin-top:\s*var\(--chat-row-gap/)
    expect(chatCss).toMatch(/\.term-row-tool \+ \.term-row-tool\s*\{[^}]*margin-top:\s*var\(--chat-tool-gap/)
  })

  it('clears profile row margins so terminal-like cadence has one source', () => {
    expect(chatCss).toMatch(/\.app\[data-interface-mode="terminal-like"\] \.term-row\s*\{[^}]*margin-block-end:\s*0/)
  })

  it('keeps every non-GUI built-in presentation profile on the same terminal-like cadence', () => {
    const expectedTerminalProfiles = [
      'builtin.presentation.terminal-classic',
      'builtin.presentation.terminal-modern',
      'builtin.presentation.paper-low-contrast',
      'builtin.presentation.console-glass',
    ]
    for (const profileId of expectedTerminalProfiles) {
      const profile = BUILTIN_PRESENTATION_PROFILES.find(candidate => candidate.id === profileId)
      expect(profile, profileId).toBeDefined()
      expect(presentationProfileInterfaceMode(profile!), profileId).toBe('terminal-like')
    }
    expect(presentationProfileInterfaceMode(BUILTIN_PRESENTATION_PROFILES.find(profile => profile.id === 'builtin.presentation.modern-gui')!)).toBe('modern-gui')
  })
})
