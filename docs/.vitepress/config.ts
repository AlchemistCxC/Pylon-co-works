import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-CN',
  title: 'Pylon 文档',
  description:
    '基于 Agent Client Protocol（ACP）的桌面 Agent 工作台——发行包、CLI 与插件系统说明。',
  // GitHub Pages 项目页：https://alchemistcxc.github.io/Pylon-co-works/
  base: '/Pylon-co-works/',
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
  ],
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '文档目录', link: '/README' },
      { text: 'GitHub', link: 'https://github.com/AlchemistCxC/Pylon-co-works' },
    ],
    sidebar: [
      {
        text: '使用指南',
        items: [
          { text: '发行包清单', link: '/说明书/Pylon-发行包清单' },
          { text: 'Agent 检测器', link: '/说明书/Pylon-Agent-检测器' },
          { text: '插件系统（用户版）', link: '/说明书/Pylon-插件系统说明书-用户版' },
          { text: 'CLI 命令表', link: '/说明书/Pylon-CLI-命令表' },
        ],
      },
      {
        text: '开发者文档',
        items: [
          { text: '项目架构参考', link: '/说明书/Pylon-项目架构参考' },
          { text: '插件系统（开发者版）', link: '/说明书/Pylon-插件系统说明书-开发者版' },
          { text: '插件化前后端拓扑全图', link: '/说明书/Pylon-插件化前后端拓扑全图' },
          { text: '模块维护地图', link: '/说明书/Pylon-模块维护地图' },
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
