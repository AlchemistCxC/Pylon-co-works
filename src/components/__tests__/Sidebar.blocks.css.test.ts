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

  it('搜索是**独立模块**的专属面板：带框输入 + 清除 + 计数 + 分组结果', () => {
    for (const selector of ['.search-field', '.search-field-input', '.search-field-clear', '.search-hint', '.search-count', '.search-results', '.search-group-head', '.search-hit']) {
      expect(body(selector), `缺少 ${selector} 规则`).toBeTruthy()
    }
    // 专属面板的输入框**应当**带框——它与会话列表里那个「嵌一行的框」是两回事。
    expect(body('.search-field')).toMatch(/border:1px solid/)
    // 旧的「会话模块内联搜索」与描边 .search-input 都不得复活。
    expect(body('.session-module-search'), '会话内联搜索已移出').toBe('')
    expect(sidebarCss, '旧描边搜索框不得复活').not.toMatch(/\.search-input\s*\{/)
  })

  it('左轨统一：模块头 / 组头 / 会话缩进都取自 --sidebar-rail-pad', () => {
    expect(body('.sidebar-block-head')).toMatch(/padding:1px var\(--sidebar-rail-pad/)
    expect(body('.cwd-group-toggle')).toMatch(/var\(--sidebar-rail-pad/)
    // 会话行的缩进不再由容器统一给，而是行内自带「图标槽 + 间距」，好让会话名与
    // 工作区名同列（`.cwd-group-sessions` 因此归零）。
    expect(body('.cwd-group-sessions')).toMatch(/padding:1px 2px 2px 0/)
    expect(body('.session-item')).toMatch(/padding:1px 6px 1px calc\(var\(--sidebar-rail-pad, 6px\) - 2px\)/)
  })

  it('拖拽有落点指示线（拖拽期间不实时重排，避免反馈环抖动）', () => {
    const marker = body('.sidebar-modules-drop')
    expect(marker, '缺少落点指示线').toBeTruthy()
    expect(marker).toMatch(/background:var\(--accent\)/)
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

  it('模块体的栅格列必须可收缩（minmax(0,1fr)），否则内容溢出被裁、行尾按钮看不见', () => {
    // 折叠动画把 body 从 flex 列改成栅格后，隐式单列默认按内容定宽：左栏 250px 时实测
    // `.session-list` 被撑到 278px，`.sidebar-block-body` 的 overflow:hidden 把行尾的
    // 「会话设置」整段裁掉（用户报「按钮完全不见了」的**真正成因**）。列必须跟随容器。
    const blockBody = body('.sidebar-block-body')
    expect(blockBody).toMatch(/grid-template-columns:minmax\(0,1fr\)/)
    expect(body('.sidebar-block-body-inner')).toMatch(/min-width:0/)
  })

  it('模块体的展开/折叠有过渡，且时长走 token（reduced-motion 靠 token 归零）', () => {
    // 用户实机报「折叠动效…只有部分地方有」：工作区组早就有 0fr 收起动画，模块体却是
    // 「折叠即卸载」的瞬跳。两侧现在同一条时间轴。
    const blockBody = body('.sidebar-block-body')
    expect(blockBody).toMatch(/grid-template-rows:\s*1fr/)
    expect(blockBody).toMatch(/transition:[^;]*grid-template-rows var\(--motion-standard\)/)
    expect(blockBody).toMatch(/overflow:\s*hidden/)
    // 0fr 收得下去的前提：栅格项必须能缩到 0。
    expect(body('.sidebar-block-body-inner')).toMatch(/min-height:\s*0/)
    expect(sidebarCss).toMatch(/\.sidebar-block\[data-collapsed="true"\] > \.sidebar-block-body \{[^}]*grid-template-rows:0fr/)
    expect(sidebarCss).toMatch(/\.sidebar-block\[data-collapsed="true"\] > \.sidebar-block-body \{[^}]*pointer-events:none/)
  })

  it('工作区组的折叠时长也是 token，不是字面毫秒（字面值不随 reduced-motion 归零）', () => {
    const group = body('.cwd-group-sessions')
    expect(group).toMatch(/transition:[^;]*grid-template-rows var\(--motion-standard\)/)
    expect(group).toMatch(/opacity var\(--motion-fast\)/)
    // 任何字面时长都意味着这条动画逃过了 reduced-motion 覆盖。
    expect(group).not.toMatch(/\d+ms/)
    expect(sidebarCss, '左栏折叠动画不得再出现字面毫秒时长').not.toMatch(/transition:[^;]*\d+ms/)
  })

  it('会话行：置顶图标占工作区图标那一列，会话名与工作区名同列（两列都要对上）', () => {
    // 行内容盒起于 x=6（1px 透明边框 + rail-2 左内边距）→ 与工作区图标同列；
    // 15px 图标槽 + 5px 间距 → 会话名落在 x=26，与工作区名同列。三处必须同源，
    // 否则「图标对齐了、名字还差几像素」或反之。
    const folder = sidebarCss.match(/\.cwd-group-folder \{([^}]*)\}/)?.[1] ?? ''
    const pin = sidebarCss.match(/\.session-pin \{([^}]*)\}/)?.[1] ?? ''
    expect(folder).toMatch(/(width|flex):[^;]*15px/)
    expect(pin).toMatch(/flex:0 0 15px/)
    expect(body('.session-item')).toMatch(/gap:5px/)
    const toggle = sidebarCss.match(/\.cwd-group-toggle \{([^}]*)\}/)?.[1] ?? ''
    expect(toggle, '工作区组头的图标↔名字间距').toMatch(/gap:5px/)
    // 模式级覆盖也必须同值：terminal-like 曾把带动作的行压到 4px，会话名因此差 1px。
    expect(sidebarCss, '模式级行间距不得偏离 5px').toMatch(/\.session-item:has\(\.session-actions\) \{\s*gap:5px/)
  })

  it('选中态用阴影而不是框：边框透明、阴影里带左侧强调条', () => {
    const active = sidebarCss.match(/\.session-item\.active \{([^}]*)\}/)?.[1] ?? ''
    expect(active, '选中态缺少阴影').toMatch(/box-shadow:inset 3px 0 0 var\(--accent\)/)
    expect(active, '选中态不得再画边框').toMatch(/border-color:transparent/)
    expect(active).not.toMatch(/border-color:var\(--state-selected-stroke\)/)
    const terminal = sidebarCss.match(/\.app\[data-interface-mode="terminal-like"\] \.session-item\.active \{([^}]*)\}/)?.[1] ?? ''
    expect(terminal).toMatch(/box-shadow:inset 3px 0 0 var\(--accent\)/)
    expect(terminal).toMatch(/border-color:transparent/)
  })

  it('会话行只有置顶与设置两个动作，且平时不可见、门控同步（不参与命中测试）', () => {
    const pin = sidebarCss.match(/\.session-pin \{([^}]*)\}/)?.[1] ?? ''
    expect(pin).toMatch(/opacity:0/)
    expect(pin).toMatch(/visibility:hidden/)
    expect(pin).toMatch(/pointer-events:none/)
    // 已置顶的常驻显示（否则看不出这条为什么排最前）。
    expect(sidebarCss).toMatch(/\.session-item\[data-pinned="true"\] > \.session-pin \{[^}]*opacity:/)
    // 旧的四钮时代类名不得复活。
    expect(sidebarCss).not.toMatch(/\.session-del\s*\{/)
    expect(sidebarCss).not.toMatch(/\.session-gear\s*\{/)
  })

  it('会话区与可排布模块的分界是「留白 + 层底 + 吸顶」，**不画线**（用户裁定的形态 B）', () => {
    const zone = sidebarCss.match(/\.sidebar-block\[data-always-open="true"\] \{([^}]*)\}/)?.[1] ?? ''
    expect(zone, '缺少常驻区层底规则').toMatch(/background:var\(--bg-panel\)/)
    // 用户明确说「不必搞成横线」：任何 border-top / 伪元素分隔线都不该出现。
    expect(zone).not.toMatch(/border/)
    const gap = sidebarCss.match(/\.sidebar-block\[data-always-open="true"\]:not\(:first-child\) \{([^}]*)\}/)?.[1] ?? ''
    expect(gap, '缺少会话区上方的额外留白').toMatch(/margin-top:\s*\d+px/)
    const head = sidebarCss.match(/\.sidebar-block\[data-always-open="true"\] > \.sidebar-block-head \{([^}]*)\}/)?.[1] ?? ''
    expect(head, '缺少吸顶标题规则').toMatch(/position:\s*sticky/)
    expect(head).toMatch(/top:\s*0/)
    // 吸顶头必须自带近乎不透明的底 + 模糊，否则会话列表会从标题底下透出字影。
    expect(head).toMatch(/background:color-mix\(in srgb,var\(--surface-panel\) 9\d%/)
    expect(head).toMatch(/backdrop-filter:blur/)
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

  it('会话行动作的显形门控在**容器**上，按钮自身不得再叠第二层', () => {
    // opacity 作用于整个子树：容器 opacity:0 时，只给按钮提 opacity 救不了——
    // 旧断言检查的「按钮自带三层门控」正是「会话设置不可见」的根因之一。
    const container = body('.session-actions')
    expect(container).toMatch(/opacity:\s*0/)
    expect(container).toMatch(/visibility:\s*hidden/)
    expect(container).toMatch(/pointer-events:\s*none/)
    const terminalAction = body('.app[data-interface-mode="terminal-like"] .session-actions > .session-action')
    expect(terminalAction, '按钮不得再带自己的 opacity/visibility 门控').not.toMatch(/opacity:/)
    expect(terminalAction).not.toMatch(/visibility:/)
    expect(terminalAction).toMatch(/cursor:\s*pointer/)
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
