import { defineConfig, type Plugin } from 'vitepress'

// 篇目文件不搬移不改名：路由经 rewrites 映射为 ASCII 路径。中文文件名直出的
// 百分号编码路径会触发 vitepress 1.6.4 缺陷——直链加载时正文空白（客户端
// 导航与 ASCII 路径均正常，实测见 #339），故不用中文路由。
const rewrites = {
  '说明书/Pylon-发行包清单.md': 'manual/release-package.md',
  '说明书/Pylon-Agent-检测器.md': 'manual/agent-detector.md',
  '说明书/Pylon-插件系统说明书-用户版.md': 'manual/plugin-system-user.md',
  '说明书/Pylon-CLI-命令表.md': 'manual/cli-commands.md',
  'README.md': 'manual/index.md',
  'Pylon-插件设置选项贡献.md': 'dev/plugin-settings-contrib.md',
  '说明书/Pylon-项目架构参考.md': 'dev/architecture.md',
  '说明书/Pylon-插件系统说明书-开发者版.md': 'dev/plugin-system-dev.md',
  '说明书/Pylon-插件化前后端拓扑全图.md': 'dev/plugin-topology.md',
  '说明书/Pylon-模块维护地图.md': 'dev/module-map.md',
}

// #371 离线变体：发行包内嵌文档站（pylon-docs:// scheme + 专用 Sheet）走
// `PYLON_DOCS_OFFLINE=1` 构建，在线站点（CI/Pages）不设该变量、行为零变化。
// - base 回根：scheme 源自带「每源根目录」语义，根绝对路径在 `pylon-docs://localhost/`
//   内正确解析；issue 里设想过的相对 base `./` 不可行——VitePress 要求 base 以 `/`
//   起止，且相对链接在嵌套路由下会解析到错误层级。
// - 裁 Web 字体：fontsource 的 CSS 经虚拟空模块短路，woff/woff2 整体不进 dist
//   （26MB → 约 4MB）；custom.css 字体栈已含系统 CJK 衬线回退，无需改样式。
const offline = process.env.PYLON_DOCS_OFFLINE === '1'

// enforce: 'pre' 抢在内建解析之前命中裸说明符，短路整个 fontsource 子树
// （woff/woff2 引用都在这些 CSS 的 url() 里），两个构建束（client/SSG）同效。
const stripWebfonts: Plugin = {
  name: 'pylon-docs-offline-strip-webfonts',
  enforce: 'pre',
  resolveId(id) {
    if (offline && id.startsWith('@fontsource/')) return '\0pylon-docs-empty-font.css'
    return null
  },
  load(id) {
    if (id === '\0pylon-docs-empty-font.css') return ''
    return null
  },
}

export default defineConfig({
  lang: 'zh-CN',
  title: 'Pylon 文档',
  description:
    '基于 Agent Client Protocol（ACP）的桌面 Agent 工作台——发行包、CLI 与插件系统说明。',
  // GitHub Pages 项目页：https://alchemistcxc.github.io/Pylon-co-works/
  base: offline ? '/' : '/Pylon-co-works/',
  vite: {
    plugins: offline ? [stripWebfonts] : [],
  },
  rewrites,
  // tactical-blue/ 是内部验收记录，不进公开站点
  srcExclude: ['tactical-blue/**'],
  ignoreDeadLinks: [
    // 篇目与 docs/README.md 索引引用仓库内源码、协作文档（.agents、CONTEXT.md、AGENTS.md、
    // 根 README）与仓外归档（../Docs，CI 环境必然不存在）：按链接形态豁免而非改篇目内容
    // （#339 承诺篇目零改动），站内死链仍被拦截。
    /\/CONTEXT(\.md)?$/,
    /dev-standards(\.md)?$/,
    /\/AGENTS(\.md)?$/,
    /\/src\//,
    /\/scripts\//,
    /\/examples\//,
    /\/README(\.md)?$/,
    /\/Docs\//,
    // vitepress 1.6.4 已知缺陷：rewrites 命中后，死链检查拿重写后的目标路由去比对
    // 「源页清单」（构建插件 pages = srcDir 源文件），篇目间中文相对链接必然误报。
    // 豁免形态 = 百分号编码的 CJK 字符（UTF-8 首字节 E4–E9）；产物链接已人工核对
    // 指向重写后的 ASCII 路由（#339 验证记录）。
    /%E[4-9]%[0-9A-F]{2}%[0-9A-F]{2}/,
  ],
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '文档目录', link: '/manual/index' },
      { text: 'GitHub', link: 'https://github.com/AlchemistCxC/Pylon-co-works' },
    ],
    sidebar: [
      {
        text: '使用指南',
        items: [
          { text: '文档目录', link: '/manual/index' },
          { text: '发行包清单', link: '/manual/release-package' },
          { text: 'Agent 检测器', link: '/manual/agent-detector' },
          { text: '插件系统（用户版）', link: '/manual/plugin-system-user' },
          { text: 'CLI 命令表', link: '/manual/cli-commands' },
        ],
      },
      {
        text: '开发者文档',
        items: [
          { text: '项目架构参考', link: '/dev/architecture' },
          { text: '插件系统（开发者版）', link: '/dev/plugin-system-dev' },
          { text: '插件设置选项贡献', link: '/dev/plugin-settings-contrib' },
          { text: '插件化前后端拓扑全图', link: '/dev/plugin-topology' },
          { text: '模块维护地图', link: '/dev/module-map' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/AlchemistCxC/Pylon-co-works' },
    ],
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
          modal: {
            noResultsText: '未找到相关结果',
            resetButtonTitle: '清除查询',
            footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
          },
        },
      },
    },
    outline: { level: [2, 3], label: '本页目录' },
    lastUpdated: { text: '最后更新' },
    docFooter: { prev: '上一篇', next: '下一篇' },
    footer: {
      message: '基于 Agent Client Protocol（ACP）构建',
      copyright: 'Copyright © 2026 Pylon Contributors',
    },
  },
})
