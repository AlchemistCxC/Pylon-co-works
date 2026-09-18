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

// 模块栈模型（ADR-0011）的静态护栏。每一条都对应一个**实机才发现**的缺陷、
// 或一个不经 CSS 就看不出来的结构性约定。
describe('左栏模块栈 CSS 契约（ADR-0011）', () => {
  it('整栈是唯一滚动容器，每个模块都是内容高度（曾被 max-height 压成互相重叠）', () => {
    const stack = body('.sidebar-modules')
    expect(stack, '缺少 .sidebar-modules').toBeTruthy()
    expect(stack).toMatch(/overflow-y:\s*auto/)
    expect(body('.sidebar-block'), '模块不得可收缩').toMatch(/flex:\s*0\s+0\s+auto/)
    // 双滚动 = 嵌套滚动陷阱：栈内滚动时列表自身不再滚。
    expect(body('.sidebar-modules .session-list')).toMatch(/overflow:\s*visible/)
  })

  it('搜索是会话模块内的**内联行**（不是描边框），左轨与模块头同基准', () => {
    const row = body('.session-module-search')
    expect(row, '缺少搜索行').toBeTruthy()
    expect(row).toMatch(/display:\s*flex/)
    expect(row).toMatch(/--sidebar-rail-pad/)
    // 描边盒模型不得复活：有 border 就又是「框」。
    expect(row).not.toMatch(/border:\s*1px/)
    const input = body('.session-search-input')
    expect(input, '内联输入框不该有边框/背景').toMatch(/border:\s*0/)
    expect(input).toMatch(/background:\s*transparent/)
    expect(sidebarCss, '旧描边搜索框已无消费方，不得复活').not.toMatch(/\.search-input\s*\{/)
  })

  it('左轨统一：模块头 / 组头 / 会话缩进都取自 --sidebar-rail-pad', () => {
    expect(body('.sidebar-block-head')).toMatch(/padding:1px var\(--sidebar-rail-pad/)
    expect(body('.cwd-group-toggle')).toMatch(/var\(--sidebar-rail-pad/)
    expect(body('.cwd-group-sessions')).toMatch(/calc\(var\(--sidebar-rail-pad/)
  })

  it('拖拽靠**长按头部**，没有独立手柄（手柄要么常驻成噪声，要么变成看不见却能拖的靶子）', () => {
    expect(body('.sidebar-block-grip'), '拖拽手柄已删除').toBe('')
    expect(sidebarCss, '手柄不得复活').not.toMatch(/\.sidebar-block-grip\s*\{/)
    expect(body('.sidebar-block-head')).toMatch(/user-select:\s*none/)
  })

  it('模块外壳部件齐备：标题 / 图标 / 折叠钮 / 动作 / 内容', () => {
    for (const selector of ['.sidebar-block', '.sidebar-block-head', '.sidebar-block-toggle', '.sidebar-block-icon', '.sidebar-block-collapse', '.sidebar-block-actions', '.sidebar-block-action', '.sidebar-block-body']) {
      expect(body(selector), `缺少 ${selector} 规则`).toBeTruthy()
    }
  })

  it('工作区组头**没有**折叠按钮（保留折叠功能：组头本身即开关）', () => {
    expect(body('.cwd-group-arrow'), '组头箭头已按用户要求删除').toBe('')
    expect(sidebarCss, '组头箭头不得复活').not.toMatch(/\.cwd-group-arrow\s*\{/)
    expect(body('.cwd-group-toggle')).toBeTruthy()
  })

  it('组头右侧只剩动作（会话计数已按用户要求移除），且未显形时不参与命中测试', () => {
    const toggle = body('.cwd-group-toggle')
    expect(toggle).not.toMatch(/padding[^;]*62px/)
    expect(body('.cwd-group-meta')).toMatch(/display:\s*grid/)
    expect(body('.cwd-group-count'), '会话计数显示已移除').toBe('')
    expect(sidebarCss, '计数不得复活').not.toMatch(/\.cwd-group-count\s*\{/)
    const actions = body('.cwd-group-actions')
    expect(actions).toMatch(/grid-area:\s*1\/1/)
    expect(actions).toMatch(/visibility:\s*hidden/)
    expect(actions).toMatch(/pointer-events:\s*none/)
  })

  it('密度：组头与会话行都是单行紧凑档，且路径行/两行栈不得复活', () => {
    const minHeightPx = (selector: string): number => {
      const match = /min-height:\s*(\d+)px/.exec(body(selector))
      expect(match, `${selector} 未声明 min-height`).not.toBeNull()
      return Number(match![1])
    }
    expect(minHeightPx('.cwd-group-head')).toBeLessThanOrEqual(28)
    expect(minHeightPx('.session-item')).toBeLessThanOrEqual(28)
    expect(body('.cwd-group-identity'), '两行身份块不得复活').toBe('')
    expect(body('.cwd-group-root'), '9.9px 目录路径行不得复活').toBe('')
    expect(body('.session-info'), '.session-info 是两行堆叠的载体').toBe('')
  })

  it('时间与操作钮共用流内格子（否则四个按钮常驻占宽会把会话名挤成省略号）', () => {
    expect(body('.session-tail')).toMatch(/display:\s*grid/)
    expect(body('.session-meta')).toMatch(/grid-area:\s*1\/1/)
    expect(body('.session-actions')).toMatch(/grid-area:\s*1\/1/)
    expect(body('.session-actions')).toMatch(/visibility:\s*hidden/)
    expect(body('.session-actions')).toMatch(/pointer-events:\s*none/)
  })

  it('会话行操作钮在未显形时退出命中测试（只给 opacity:0 会吃掉落在行中段的点击）', () => {
    const hidden = body('.app[data-interface-mode="terminal-like"] .session-item > .session-action')
    expect(hidden).toMatch(/opacity:\s*0/)
    expect(hidden).toMatch(/visibility:\s*hidden/)
    expect(hidden).toMatch(/pointer-events:\s*none/)
  })

  it('字号与会话同源：模块标题/组名/行名用同一 token，次要文字用 meta token', () => {
    for (const selector of ['.sidebar-block-toggle', '.cwd-group-name', '.sidebar-block-row-name']) {
      expect(body(selector), `${selector} 应与会话名同源`).toMatch(/font-size:var\(--sidebar-name-size/)
    }
    for (const selector of ['.session-meta', '.sidebar-block-row-meta']) {
      expect(body(selector), `${selector} 应使用统一 meta 字号`).toMatch(/--sidebar-meta-size/)
    }
  })

  it('主区整页的部件齐备（页容器 / 头部 / 返回 / 标题 / 正文）', () => {
    for (const selector of ['.agent-sheet-page', '.agent-sheet-page-head', '.agent-sheet-page-back', '.agent-sheet-page-title', '.agent-sheet-page-body']) {
      expect(body(selector), `缺少 ${selector} 规则`).toBeTruthy()
    }
    expect(body('.agent-sheet-page')).toMatch(/display:\s*flex/)
  })

  it('折叠态可见性兜底仍在（ADR-0009 的「折叠 = 0 宽」依赖它）', () => {
    expect(body('.layout[data-sidebar="collapsed"] .sidebar *')).toContain('visibility:hidden')
  })
})
