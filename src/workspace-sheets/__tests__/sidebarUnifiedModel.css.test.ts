import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(p, 'utf8')
const appCss = read('src/plugins/product/packages/builtin.pylon-shell/styles/App.css')
const sidebarCss = read('src/plugins/product/packages/builtin.pylon-workspace/styles/components/Sidebar.css')
const overviewCss = read('src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/OverviewSheetView.css')
const fileCss = read('src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/file/FileSheet.css')
const prismCss = read('src/plugins/product/packages/builtin.pylon-workspace/styles/components/PrismSheet.css')

/**
 * 取某选择器直接跟 `{` 的规则体（也命中逗号列表成员与后代选择器的末段）。
 * 不用「按 `}` 切分再比选择器列表」的做法：选择器文本前面常带注释，
 * 整体比较会漏匹配。
 */
function ruleBodies(css: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g')
  const out: string[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(css)) !== null) out.push(match[1])
  return out
}

/** 跨包扫描：任何文件里出现的规则文本（用于「退休 token 不得复活」的全文断言）。 */
const FIRST_PARTY_CSS = [
  appCss,
  sidebarCss,
  overviewCss,
  fileCss,
  prismCss,
  read('src/plugins/product/packages/builtin.pylon-workspace/styles/SheetVocabulary.css'),
  read('src/plugins/product/packages/builtin.pylon-workspace/styles/adaptive.css'),
  read('src/plugins/product/packages/builtin.pylon-shell/styles/components/Settings.css'),
  read('src/plugins/product/packages/builtin.pylon-shell/styles/components/SettingsCommon.css'),
  read('src/plugins/product/packages/builtin.pylon-shell/styles/components/SessionSettings.css'),
]

const RETIRED_WIDTH_TOKENS = [
  '--sheet-sidebar-width',
  '--workspace-sidebar-track-width',
  '--workspace-sidebar-collapsed-width',
  '--titlebar-sidebar-width',
]

// #154：左列曾经有「三套独立宽度 + 两套独立边框」，那是浏览器/Gateway 分割线
// 错位的结构性成因。这组断言把收敛后的模型静态钉住：宽度只有一个真值、分割线
// 只有一个所有者、折叠是布局层状态而不是各 Sheet 的私事。
describe('#154 左列统一模型 CSS 契约', () => {
  it('宽度只有 --sheet-sidebar-track-width 一个真值，且由 .sidebar 消费', () => {
    const body = ruleBodies(sidebarCss, '.sidebar')[0]
    expect(body, '缺少 .sidebar 规则').toBeTruthy()
    expect(body).toContain('--sheet-sidebar-track-width')
    for (const prop of ['width', 'min-width', 'max-width']) {
      expect(body, `.sidebar 的 ${prop} 必须取自唯一宽度真值`).toMatch(new RegExp(`${prop}:var\\(--sheet-sidebar-track-width`))
    }
  })

  it('四套旧宽度 token 在第一方 CSS 中彻底退役（复活 = 又出现第二条宽度来源）', () => {
    for (const css of FIRST_PARTY_CSS) {
      for (const token of RETIRED_WIDTH_TOKENS) {
        // 允许出现在 #154 的说明性注释里，但不允许出现在任何声明中。
        const inDeclaration = new RegExp(`${token}\\s*,?\\s*[0-9]`).test(css) || new RegExp(`:\\s*[^;\\n]*${token}`).test(css)
        expect(inDeclaration, `${token} 仍被声明消费`).toBe(false)
      }
    }
  })

  it('竖直分割线只有一个所有者：布局层的 .layout[data-sidebar="expanded"]::before', () => {
    expect(appCss).toMatch(/\.layout\[data-sidebar="expanded"\]::before\s*\{[^}]*background:var\(--border\)/)
    // 镜像（侧栏在右）时整条线换边，仍只有这一条。
    expect(appCss).toMatch(/\.app\[data-shell-sidebar-side="right"\] \.layout\[data-sidebar="expanded"\]::before\s*\{[^}]*right:calc\(/)
    // 折叠时整条线不画——这消灭了「标题栏留下 42px 悬空分割线」。
    expect(appCss).toMatch(/\.layout\[data-sidebar="collapsed"\] \.left-rail-resize-handle\s*\{\s*display:none/)
  })

  it('各 Sheet 的左栏 CSS 不再自画竖边框', () => {
    for (const selector of ['.overview-sidebar', '.file-sidebar', '.ps-nav']) {
      for (const body of ruleBodies(overviewCss + fileCss + prismCss, selector)) {
        expect(body, `${selector} 不得自带竖边框`).not.toMatch(/border-right/)
      }
    }
  })

  it('折叠可见性是布局层状态，且会继承到所有后代（挡得住键盘焦点）', () => {
    const collapsed = ruleBodies(sidebarCss, '.layout[data-sidebar="collapsed"] .sidebar')[0]
    expect(collapsed, '缺少折叠态规则').toBeTruthy()
    expect(collapsed).toContain('visibility:hidden')
  })

  it('拖拽手柄按同一 token 定位，折叠时隐藏', () => {
    const body = ruleBodies(appCss, '.left-rail-resize-handle')[0]
    expect(body, '缺少 .left-rail-resize-handle 规则').toBeTruthy()
    expect(body).toContain('--sheet-sidebar-track-width')
    expect(body).toContain('col-resize')
    // 拖拽期间关过渡，否则每个 pointermove 的过渡互相打断会拖出尾迹。
    expect(appCss).toMatch(/\.layout\.is-resizing[^{]*\{[^}]*transition:none/)
  })
})
