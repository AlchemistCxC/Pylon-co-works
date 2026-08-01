import { lazy } from 'react'
import type { Components } from 'react-markdown'

// react-markdown + remark-gfm（micromark 栈，压缩后约 150kB+）不随主包加载：
// 仅当首条非纯文本消息真正渲染 Markdown 时才按需拉取，后续复用模块缓存。
export const MarkdownRenderer = lazy(async () => {
  const [{ default: ReactMarkdown }, { default: remarkGfm }] = await Promise.all([
    import('react-markdown'),
    import('remark-gfm'),
  ])
  const Component = ({ components, children }: { components?: Components; children?: string }) => (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{children}</ReactMarkdown>
  )
  return { default: Component }
})
