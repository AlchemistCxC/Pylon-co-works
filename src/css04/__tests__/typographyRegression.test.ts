// @vitest-environment jsdom

/**
 * CSS-04：P6 页面回归（方案书任务表 CSS-04，§5.15 step 6——运行其他 Sheet screenshot/DOM
 * smoke，确认无全局 heading 污染）。
 *
 * 覆盖四组回归门：
 *   1. 源码锁：ChatView.css 中任何 `.term-h{n}` 规则必须被 `.term-assistant` 限定（无裸
 *      全局选择器 → 其他 Sheet 原生 h1-h6 不会被聊天层级规则污染）。
 *   2. CSS-03 回归门：聊天 CSS 无 `\d+pt` 字号引用（px contract 保持）。
 *   3. renderer 源码锁（CR-325 消化）：React/Solid 双 renderer 的 heading class 输出仍在
 *      （与 css01 headingDomContract 不同源，可直接捕获 renderer 映射被删的回归；
 *      Solid 侧另配真实 DOM renderer 测试 MarkdownContent.solid.test.tsx）。
 *   4. DOM smoke：真实 ChatView.css 经样式表加载（jsdom CSSOM 解析 267 条规则）后，
 *      `.term-h{n}` 规则全部保持 `.term-assistant` scoping 且 h1~h6 六条齐备。
 *
 * 注：jsdom getComputedStyle 的 descendant 匹配有已知局限（.term-assistant .term-h1 会误命中
 * 非后代元素），故 computed style 断言不可行；改用 CSSOM 规则结构断言（真实解析后的规则形态）。
 */

import { describe, expect, it } from 'vitest'
import chatViewTsx from '../../components/chat/ChatView.tsx?raw'
import markdownSolidSource from '../../renderers/solid-workbench/chat/MarkdownContent.solid.tsx?raw'
import {
  CHAT_VIEW_CSS,
  findPtFontSizeReferences,
  findUnscopedHeadingRules,
  HEADING_CLASSES,
} from '../typographyRegression'

describe('源码锁：heading 规则作用域（§5.15 step 5 防污染）', () => {
  it('ChatView.css 中任何 .term-h{n} 规则必须被 .term-assistant 限定（无裸全局选择器）', () => {
    expect(findUnscopedHeadingRules(CHAT_VIEW_CSS)).toEqual([])
  })

  it('ChatView.css 存在完整 6 级 .term-assistant .term-h{n} 规则（h1~h6 全覆盖）', () => {
    for (const cls of HEADING_CLASSES) {
      expect(CHAT_VIEW_CSS).toContain(`.term-assistant .${cls}`)
    }
  })

  it('CSS-03 回归门：聊天 CSS 无 \\d+pt 字号引用（px contract 保持）', () => {
    expect(findPtFontSizeReferences(CHAT_VIEW_CSS)).toEqual([])
  })
})

describe('renderer 源码锁（CR-325 消化：捕获 renderer class 输出回归）', () => {
  it('React renderer（ChatView.tsx）h1-h6 components 映射仍在', () => {
    for (const level of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      expect(chatViewTsx).toContain(`<${level} className="term-${level}"`)
    }
  })

  it('Solid renderer（MarkdownContent.solid.tsx）headingClass 派生仍在', () => {
    expect(markdownSolidSource).toContain('/^h[1-6]$/')
    expect(markdownSolidSource).toContain('term-${tagName}')
    expect(markdownSolidSource).toContain('<Dynamic')
  })
})

describe('DOM smoke：真实 ChatView.css 样式表加载后的规则结构（jsdom CSSOM 解析）', () => {
  function loadChatCss(): HTMLStyleElement {
    const style = document.createElement('style')
    style.textContent = CHAT_VIEW_CSS
    document.head.appendChild(style)
    return style
  }

  function cssRules(style: HTMLStyleElement): CSSRule[] {
    return Array.from(style.sheet?.cssRules ?? [])
  }

  function styleRules(): CSSStyleRule[] {
    const style = loadChatCss()
    try {
      return cssRules(style).filter((rule): rule is CSSStyleRule => 'selectorText' in rule)
    } finally {
      style.remove()
    }
  }

  it('term-h{n} 规则全部 .term-assistant 限定，且 h1~h6 六条齐备（无裸全局选择器）', () => {
    const style = loadChatCss()
    try {
      const rules = cssRules(style).filter((rule): rule is CSSStyleRule => 'selectorText' in rule)
      const headingRules = rules.filter(rule => /\.term-h[1-6](?![\w-])/.test(rule.selectorText))
      expect(headingRules).toHaveLength(6)
      for (const cls of HEADING_CLASSES) {
        const found = headingRules.filter(rule => rule.selectorText === `.term-assistant .${cls}`)
        expect(found).toHaveLength(1)
        expect(found[0].cssText).toContain(cls)
      }
      // 解析后的规则结构：不存在未限定 .term-assistant 的 .term-h{n} 规则
      for (const rule of rules) {
        if (/\.term-h[1-6](?![\w-])/.test(rule.selectorText)) {
          expect(rule.selectorText).toContain('.term-assistant')
        }
      }
    } finally {
      style.remove()
    }
  })

  it('px contract 回归门：样式表解析后的规则文本无 \\d+pt 字号引用（CSS-03 后）', () => {
    const style = loadChatCss()
    try {
      const text = cssRules(style).map(rule => rule.cssText).join('\n')
      expect(/\d+(?:\.\d+)?pt/.test(text)).toBe(false)
      // .term 规则存在且携带 --chat-font-size 注入点（变量缺失时 px fallback 语义）
      const termRule = styleRules().find(rule => rule.selectorText === '.term')
      expect(termRule).toBeDefined()
      expect(termRule!.cssText).toContain('--chat-font-size')
    } finally {
      style.remove()
    }
  })
})
