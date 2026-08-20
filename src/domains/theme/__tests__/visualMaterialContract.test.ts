import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function localPath(relativePath: string): string {
  const pathname = decodeURIComponent(new URL(relativePath, import.meta.url).pathname)
  return /^\/[a-zA-Z]:\//.test(pathname) ? pathname.slice(1) : pathname
}

const kernelStyles = readFileSync(localPath('../../../index.css'), 'utf8')
const shellStyles = readFileSync(localPath('../../../plugins/product/packages/builtin.pylon-shell/styles/App.css'), 'utf8')
const workspaceStyles = readFileSync(localPath('../../../plugins/product/packages/builtin.pylon-workspace/styles/components/Sidebar.css'), 'utf8')

describe('Pylon visual material contract', () => {
  it('applies background opacity directly and blurs the owned background layer', () => {
    expect(kernelStyles).toContain('opacity:var(--t,.85)')
    expect(kernelStyles).toContain('filter:blur(var(--blur,16px))')
    expect(kernelStyles).not.toContain('opacity: calc(1 - var(--t')
    expect(kernelStyles).toContain('--surface-panel:')
    expect(kernelStyles).toContain('--surface-overlay:')
    expect(kernelStyles).toContain('--surface-sunken:')
    expect(kernelStyles).toContain('--surface-glass:')
    expect(kernelStyles).toContain('--state-selected-bg:')
    expect(kernelStyles).toContain('--state-focus-ring:')
    expect(kernelStyles).toContain('--state-danger-surface:')
    expect(kernelStyles).toContain('--ease-emphasized:')
  })

  it('collapses host motion durations when the operating system requests reduced motion', () => {
    expect(kernelStyles).toContain('@media (prefers-reduced-motion: reduce)')
    expect(kernelStyles).toMatch(/--motion-standard:\s*1ms/)
    expect(kernelStyles).toMatch(/transition-duration:1ms !important/)
  })

  it('keeps plugin-owned background images on the same real blur pipeline', () => {
    expect(workspaceStyles).toContain('filter:blur(var(--sidebar-blur,0px))')
    expect(workspaceStyles).not.toContain('backdrop-filter:blur(var(--sidebar-blur')
  })

  it('expresses the persistent brand tag as connected status nodes', () => {
    expect(shellStyles).toContain('.agent-status-lights::before')
    expect(shellStyles).toContain('var(--brand-node-ready)')
    expect(shellStyles).toContain('var(--brand-node-warn)')
    expect(shellStyles).toContain('var(--brand-node-error)')
  })
})
