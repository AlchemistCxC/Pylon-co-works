// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { MarkdownPreview } from '../MarkdownPreview'

// #276：FileTabView markdown 预览的 wasm 计算核渲染路径。解析走真实
// pylon-markdown（vitest globalSetup 预载 wasm），断言的是「渲染模型 → React
// 元素」投影的形状契约：属性名连字符化、className 拍平、非受控表单字段。

async function renderMarkdown(text: string) {
  const result = render(<MarkdownPreview text={text} />)
  // wasm 装载 + 解析落地前是加载态（承接原 Suspense fallback 文案）
  expect(result.container.querySelector('.file-tab-hint')?.textContent).toBe('加载 Markdown…')
  await waitFor(() => {
    expect(result.container.querySelectorAll('.file-tab-hint')).toHaveLength(0)
  })
  return result
}

describe('MarkdownPreview', () => {
  it('标题/段落/行内标记渲染为裸元素流', async () => {
    const { container } = await renderMarkdown('# 标题一\n\n段落含 **加粗** 与 `code` 文本。\n')
    expect(container.querySelector('h1')?.textContent).toBe('标题一')
    const paragraph = container.querySelector('p')!
    expect(paragraph.textContent).toBe('段落含 加粗 与 code 文本。')
    expect(paragraph.querySelector('strong')?.textContent).toBe('加粗')
    expect(paragraph.querySelector('code')?.textContent).toBe('code')
  })

  it('表格保留 align 属性（GFM 列对齐）', async () => {
    const { container } = await renderMarkdown(
      '| 左 | 中 | 右 |\n| :- | :-: | -: |\n| a | b | c |\n',
    )
    const table = container.querySelector('table')!
    expect(table).toBeTruthy()
    const head = table.querySelectorAll('th')
    expect(head[0]!.getAttribute('align')).toBe('left')
    expect(head[1]!.getAttribute('align')).toBe('center')
    expect(head[2]!.getAttribute('align')).toBe('right')
  })

  it('任务列表复选框投影为非受控（defaultChecked + disabled）', async () => {
    const { container } = await renderMarkdown('- [x] 完成\n- [ ] 待办\n')
    const checkboxes = container.querySelectorAll('input[type="checkbox"]')
    expect(checkboxes).toHaveLength(2)
    // 非受控投影的判据是无 React「受控字段缺 onChange」告警（vitest.setup 白名单
    // 硬断言会拦）。defaultChecked 按 HTML 规范会反射 checked 内容属性，不断言其缺失。
    expect((checkboxes[0] as HTMLInputElement).defaultChecked).toBe(true)
    expect((checkboxes[1] as HTMLInputElement).defaultChecked).toBe(false)
    for (const box of checkboxes) expect(box.hasAttribute('disabled')).toBe(true)
    expect(container.querySelector('li')?.className).toContain('task-list-item')
  })

  it('GFM 脚注：ariaLabel/data 属性连字符化，锚点可达', async () => {
    const { container } = await renderMarkdown('正文[^1]\n\n[^1]: 注释内容\n')
    const reference = container.querySelector('sup')!
    expect(reference.getAttribute('aria-label')).toBe('Reference 1')
    const ref = reference.querySelector('a')!
    expect(ref.getAttribute('data-footnote-ref')).toBe('true')
    expect(ref.getAttribute('href')).toBe('#user-content-fn-1')
    const footnotes = container.querySelector('section[data-footnotes]')
    expect(footnotes?.textContent).toContain('注释内容')
  })

  it('代码块语言类保留（无高亮表现层，与原路径对齐）', async () => {
    const { container } = await renderMarkdown('```ts\nconst x = 1\n```\n')
    const code = container.querySelector('pre code')!
    expect(code.className).toBe('language-ts')
    expect(code.textContent).toBe('const x = 1\n')
  })

  it('链接/图片属性透传', async () => {
    const { container } = await renderMarkdown(
      '[文档](https://example.com) 与 ![图](https://example.com/a.png)\n',
    )
    const anchor = container.querySelector('a')!
    expect(anchor.getAttribute('href')).toBe('https://example.com')
    expect(anchor.textContent).toBe('文档')
    const image = container.querySelector('img')!
    expect(image.getAttribute('src')).toBe('https://example.com/a.png')
    expect(image.getAttribute('alt')).toBe('图')
  })
})
