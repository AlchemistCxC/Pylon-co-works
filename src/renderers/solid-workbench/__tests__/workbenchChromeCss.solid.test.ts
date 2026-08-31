import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Solid 工作台壳层 CSS 契约（过渡态：中控区输入栏生产接线，位置正常）。
 *
 * 断言对象是 WorkbenchChrome.css 的文本规则——与 radiusContract 同款文件读取模式。
 * 每条规则对应一个已证实的裸类（见 references/solid-chrome-gap-audit.md 的 22 类清单），
 * 本过渡态只覆盖布局骨架必需的 8 个类；其余留待 P2-P4。
 */
const css = (relativePath: string) => {
  const pathname = decodeURIComponent(new URL(relativePath, import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
  return readFileSync(pathname, 'utf8')
}

const chromeCss = css('../../../plugins/product/packages/builtin.pylon-renderers/styles/components/solid-workbench/WorkbenchChrome.css')

describe('Solid 工作台壳层样式契约', () => {
  it('suite 挂载壳补齐 main-body 等价几何（flex 列 + min-height:0 + overflow:hidden + right-inset 变量）', () => {
    const block = extractBlock(chromeCss, '.renderer-suite-workbench')
    expect(block, 'renderer-suite-workbench 缺 flex column').toContain('flex-direction:column')
    expect(block, 'renderer-suite-workbench 缺 min-height:0').toContain('min-height:0')
    expect(block, 'renderer-suite-workbench 缺 overflow:hidden').toContain('overflow:hidden')
    expect(block, 'renderer-suite-workbench 未消费 --right-panel-inset 联动变量').toContain('--right-panel-inset')
    // mount 层必须撑满宿主
    const mount = extractBlock(chromeCss, '.renderer-suite-workbench-mount')
    expect(mount, 'mount 层未撑满（缺 display:flex 与 flex:1）').toContain('flex')
  })

  it('solid-agent-workbench 是纵向 flex 容器且消息流可伸缩', () => {
    const block = extractBlock(chromeCss, '.solid-agent-workbench')
    expect(block).toContain('display:flex')
    expect(block).toContain('flex-direction:column')
    expect(block).toContain('min-height:0')
  })

  it('生产中控槽位复用 control-center 几何：底部停靠且不参与消息流伸缩', () => {
    const cc = extractBlock(chromeCss, '.solid-workbench-control-center-slot')
    expect(cc, '中控槽缺 margin-top:auto 底部停靠').toContain('margin-top:auto')
    expect(cc, '中控槽缺 flex-shrink:0（会被消息流挤压）').toContain('flex-shrink:0')
  })

  it('pet 占位与裸 surface 区块在过渡态受控（activity 行不得偏离消息指示列）', () => {
    const pet = extractBlock(chromeCss, ".solid-workbench-pet-slot[data-fixture='pending']")
    expect(pet, 'pet 文字占位必须隐藏（data-fixture=pending 过渡态不展示假 UI）').toContain('display:none')
    const timeline = extractBlock(chromeCss, '.solid-workbench-timeline')
    expect(timeline, 'timeline 裸区块缺最小间距').toMatch(/margin|padding/)
    const activities = extractBlock(chromeCss, '.solid-workbench-activities')
    expect(activities).toMatch(/margin|padding/)
    expect(activities, 'activity 列表嵌入消息流后不得增加水平外边距，否则工具指示器会偏离助手圆点').toContain('margin:8px00')
  })

  it('回放只读遮罩有可见形态（position+层级），空态居中', () => {
    const replay = extractBlock(chromeCss, '.solid-workbench-replay-overlay')
    expect(replay).toContain('position:absolute')
    expect(replay).toMatch(/z-index/)
    const empty = extractBlock(chromeCss, '.solid-workbench-empty-space')
    expect(empty).toContain('flex:1')
  })

  it('C14 session surfaces consume layout/density/warning tokens and retain keyboard focus visibility', () => {
    const surface = extractBlock(chromeCss, '.solid-session-surface')
    expect(surface).toContain('display:grid')
    expect(surface).toContain('border:')
    const warning = extractBlock(chromeCss, ".solid-session-budget[data-warning='true'][data-palette='semantic']")
    expect(warning).toMatch(/--warning|--danger|--accent/)
    const inline = extractBlock(chromeCss, ".solid-session-config[data-layout='inline'] .solid-session-config-option")
    expect(inline).toContain('grid-template-columns')
    const compact = extractBlock(chromeCss, ".solid-session-commands[data-density='compact'] .solid-session-command")
    expect(compact).toMatch(/padding|gap/)
    const focus = extractBlock(chromeCss, '.solid-session-assist:focus-visible')
    expect(focus).toContain('outline')
  })
})

/** 从 CSS 文本提取指定选择器的声明块（取首次出现），并压缩空白便于断言。 */
function extractBlock(source: string, selector: string): string {
  // 精确匹配：选择器后必须紧跟空白或 '{'，避免前缀误命中（如 -mount 前缀撞 .renderer-suite-workbench）
  const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s*\\{)`)
  const match = pattern.exec(source)
  if (!match) throw new Error(`CSS 中找不到选择器 ${selector}`)
  const open = source.indexOf('{', match.index)
  const close = source.indexOf('}', open)
  return source.slice(open + 1, close).replaceAll(/\s+/g, '')
}
