import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function localPath(relativePath: string): string {
  const pathname = decodeURIComponent(new URL(relativePath, import.meta.url).pathname)
  return /^\/[a-zA-Z]:\//.test(pathname) ? pathname.slice(1) : pathname
}

const kernelStyles = readFileSync(localPath('../../../index.css'), 'utf8')
const shellStyles = readFileSync(localPath('../../../plugins/product/packages/builtin.pylon-shell/styles/App.css'), 'utf8')
const workspaceStyles = readFileSync(localPath('../../../plugins/product/packages/builtin.pylon-workspace/styles/components/Sidebar.css'), 'utf8')

/** 选择器块内归一：按选择器正则定位规则块并去除全部空白（书写格式与属性顺序不耦合） */
function compactRuleBlock(cssText: string, selector: RegExp): string {
  const match = selector.exec(cssText)
  if (!match) throw new Error(`缺少规则：${selector}`)
  const end = cssText.indexOf('}', match.index)
  if (end < 0) throw new Error(`区块未闭合：${selector}`)
  return cssText.slice(match.index, end).replace(/\s+/g, '')
}

describe('Pylon visual material contract', () => {
  it('applies background opacity directly and blurs the owned background layer（块内归一断言）', () => {
    // 归一化到 body::before 拥有的背景层区块内断言，不依赖书写格式
    const ownedLayer = compactRuleBlock(kernelStyles, /body::before\s*\{/)
    expect(ownedLayer).toContain('opacity:var(--t,.85)')
    expect(ownedLayer).toContain('filter:blur(var(--blur,16px))')
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
    expect(shellStyles).not.toContain('.agent-status-lights::before')
    expect(shellStyles).toContain('var(--brand-node-ready)')
    expect(shellStyles).toContain('var(--brand-node-warn)')
    expect(shellStyles).toContain('var(--brand-node-error)')
  })

  it('keeps the error tray anchor deterministic across embedded WebViews（块内归一断言，不钉像素值）', () => {
    const badge = compactRuleBlock(shellStyles, /\.error-center-badge\s*\{/)
    const tray = compactRuleBlock(shellStyles, /\.error-center\s*\{/)
    // 徽标固定锚定右下角：right 与 bottom 取同一偏移（同角对齐，改值需成对）
    const badgeAnchor = badge.match(/right:([^;]+);bottom:([^;]+)/)
    expect(badgeAnchor).not.toBeNull()
    expect(badgeAnchor![1]).toBe(badgeAnchor![2])
    // 托盘与徽标同右缘；bottom 走可配置 dock 变量（带 fallback），不硬编码 safe-area
    const trayRight = tray.match(/right:([^;]+)/)
    expect(trayRight).not.toBeNull()
    expect(trayRight![1]).toBe(badgeAnchor![1])
    expect(tray).toContain('bottom:var(--error-center-bottom,')
    expect(shellStyles).not.toContain('safe-area-inset-bottom')
    expect(shellStyles).not.toContain('safe-area-inset-right')
  })
})
