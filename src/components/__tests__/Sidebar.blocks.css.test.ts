import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sidebarCss = readFileSync('src/plugins/product/packages/builtin.pylon-workspace/styles/components/Sidebar.css', 'utf8')

/** 取选择器列表中**恰好包含**该选择器的规则体（与 #154 的 CSS 契约测试同一手法）。 */
function ruleBodies(css: string, selector: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: string[] = []
  const re = /([^{}]+)\{([^}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = re.exec(withoutComments)) !== null) {
    if (match[1].split(',').map(s => s.trim()).includes(selector)) out.push(match[2])
  }
  return out
}

const body = (selector: string) => ruleBodies(sidebarCss, selector).join('\n')

// 区块栈模型（ADR-0011）的静态护栏。这里的每一条都对应一个**实机才发现**的缺陷，
// 或一个不经 CSS 就看不出来的结构性约定。
describe('左栏区块栈 CSS 契约（ADR-0011）', () => {
  it('模块区区块不得被压缩——否则四个区块互相重叠（实测自然高 418 被压成 111/85/69/51）', () => {
    const modules = body('.sidebar-region[data-region="modules"]')
    expect(modules, '模块区需要上限').toMatch(/max-height/)
    expect(modules, '模块区需要自己滚动').toMatch(/overflow-y:\s*auto/)
    expect(body('.sidebar-region[data-region="modules"] > .sidebar-block'), '区块必须 flex:0 0 auto')
      .toMatch(/flex:\s*0\s+0\s+auto/)
  })

  it('会话区占满剩余高度，且是左栏唯一的会话滚动态', () => {
    expect(body('.sidebar-region[data-region="sessions"]')).toMatch(/flex:\s*1\s+1\s+auto/)
    expect(body('.sidebar-block[data-region="sessions"]')).toMatch(/flex:\s*1\s+1\s+auto/)
    expect(body('.session-list')).toMatch(/overflow-y:\s*auto/)
  })

  it('搜索框声明高度且**不得**用 flex:1（纵向 flex 里 flex-basis:0 会压掉 height，实测 17px vs 声明 36px）', () => {
    const search = body('.search-input')
    expect(search, '缺少 .search-input 规则').toBeTruthy()
    expect(search).toMatch(/height:var\(--ui-control-standard/)
    expect(search, 'flex:1 会再次压掉声明高度').not.toMatch(/flex:\s*1\b/)
    expect(search, 'flex-basis 不得为 0').not.toMatch(/flex-basis:\s*0/)
  })

  it('区块外壳由宿主拥有的四个部件齐备（标题 / 折叠钮 / 箭头 / 头部动作）', () => {
    for (const selector of ['.sidebar-block', '.sidebar-block-head', '.sidebar-block-toggle', '.sidebar-block-arrow', '.sidebar-block-title', '.sidebar-block-actions', '.sidebar-block-action', '.sidebar-block-body']) {
      expect(body(selector), `缺少 ${selector} 规则`).toBeTruthy()
    }
  })

  it('组头的计数与动作共用流内格子，不再靠 toggle 的 62px 手抄预留', () => {
    const toggle = body('.cwd-group-toggle')
    expect(toggle, 'padding-right:62px 是「加第三个动作就静默压字」的漂移源').not.toMatch(/padding[^;]*62px/)
    const meta = body('.cwd-group-meta')
    expect(meta, '需要一个承载计数与动作的流内格子').toBeTruthy()
    expect(meta).toMatch(/display:\s*grid/)
    expect(body('.cwd-group-count')).toMatch(/grid-area:\s*1\/1/)
    expect(body('.cwd-group-actions')).toMatch(/grid-area:\s*1\/1/)
  })

  it('会话行操作钮在未显形时退出命中测试（只给 opacity:0 会吃掉落在行中段的点击）', () => {
    const hidden = ruleBodies(sidebarCss, '.app[data-interface-mode="terminal-like"] .session-item > .session-action').join('\n')
    expect(hidden).toMatch(/opacity:\s*0/)
    expect(hidden, '缺少 visibility:hidden → 淡入窗口内仍可点').toMatch(/visibility:\s*hidden/)
    expect(hidden, '缺少 pointer-events:none → 隐藏时仍是命中目标').toMatch(/pointer-events:\s*none/)
  })

  it('折叠态可见性兜底仍在（ADR-0009 的「折叠 = 0 宽」依赖它）', () => {
    expect(body('.layout[data-sidebar="collapsed"] .sidebar *')).toContain('visibility:hidden')
  })
})

// 密度与「点标题开页」的护栏。用户点名「卡片占用高度太大、大片空白、折叠按钮太显眼」，
// 这些数值只靠目视很容易在后续改动里长回去。
describe('左栏密度与整页入口 CSS 契约', () => {
  const minHeightPx = (selector: string): number => {
    const match = /min-height:\s*(\d+)px/.exec(body(selector))
    expect(match, `${selector} 未声明 min-height`).not.toBeNull()
    return Number(match![1])
  }

  it('会话行是单行紧凑档：min-height 不超过 28px', () => {
    expect(minHeightPx('.session-item')).toBeLessThanOrEqual(28)
    // 两行堆叠时代的容器（名称 + 时间各占一行）不得复活。
    expect(body('.session-info'), '.session-info 是两行堆叠的载体').toBe('')
  })

  it('时间与操作钮共用流内格子（否则四个按钮常驻占宽会把会话名挤成省略号）', () => {
    expect(body('.session-tail')).toMatch(/display:\s*grid/)
    expect(body('.session-meta')).toMatch(/grid-area:\s*1\/1/)
    expect(body('.session-actions')).toMatch(/grid-area:\s*1\/1/)
    expect(body('.session-actions')).toMatch(/visibility:\s*hidden/)
    expect(body('.session-actions')).toMatch(/pointer-events:\s*none/)
  })

  it('组头压成单行紧凑档，且不再渲染目录路径行', () => {
    expect(minHeightPx('.cwd-group-head')).toBeLessThanOrEqual(28)
    expect(body('.cwd-group-identity'), '两行身份块不得复活').toBe('')
    expect(body('.cwd-group-root'), '9.5px 目录路径行不得复活（已降级为 tooltip）').toBe('')
  })

  it('折叠箭头默认淡出、悬停/聚焦才亮（用户点名太显眼）', () => {
    for (const selector of ['.cwd-group-arrow', '.sidebar-block-arrow']) {
      const rule = body(selector)
      const opacity = /opacity:\s*(\.\d+|0)\)?/.exec(rule)
      expect(opacity, `${selector} 缺少默认淡出`).not.toBeNull()
      expect(Number(opacity![1])).toBeLessThanOrEqual(0.4)
    }
    expect(sidebarCss).toMatch(/\.sidebar-block-head:hover \.sidebar-block-arrow/)
    expect(sidebarCss).toMatch(/\.cwd-group:hover \.cwd-group-arrow/)
  })

  it('区块折叠钮与「打开整页」的标题是两个独立控件', () => {
    expect(body('.sidebar-block-collapse'), '缺少独立折叠钮规则').toBeTruthy()
    expect(body('.sidebar-block[data-page-open="true"] .sidebar-block-title'), '缺打开态高亮').toMatch(/color:\s*var\(--accent\)/)
  })

  it('主区整页的部件齐备（页容器 / 头部 / 返回 / 标题 / 正文）', () => {
    for (const selector of ['.agent-sheet-page', '.agent-sheet-page-head', '.agent-sheet-page-back', '.agent-sheet-page-title', '.agent-sheet-page-body']) {
      expect(body(selector), `缺少 ${selector} 规则`).toBeTruthy()
    }
    expect(body('.agent-sheet-page')).toMatch(/display:\s*flex/)
  })
})
