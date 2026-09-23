import { createElement, useEffect, useState, type ReactNode } from 'react'
import {
  loadMarkdownCompute,
  type MarkdownModelElement,
  type MarkdownModelNode,
  type MarkdownModelRoot,
} from '../../infrastructure/compute/markdownCompute.ts'
import { reportRuntimeError } from '../../runtimeError.ts'

// hast 语义属性名（camelCase）→ React 属性名：aria/data 家族需连字符小写化
// （React 对驼峰的自定义属性会原样小写展开，`dataFootnoteRef` 会丢中段），其余透传。
function toDashCase(name: string): string {
  return name.replace(/[A-Z]/g, character => `-${character.toLowerCase()}`)
}

// React 对「有 checked/value 却无 onChange」的受控表单字段会告警（测试侧 console.error
// 白名单硬断言会拦）。文件预览的复选框/字段是纯展示，按非受控投影。
const UNCONTROLLED_FORM_PROPS = new Set(['checked', 'value'])

function modelPropertiesToReactProps(properties: MarkdownModelElement['properties']): Record<string, unknown> {
  const reactProps: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(properties)) {
    if (value === undefined || value === null) continue
    if (name === 'className') {
      const className = Array.isArray(value) ? value.join(' ') : String(value)
      if (className !== '') reactProps.className = className
    } else if (UNCONTROLLED_FORM_PROPS.has(name)) {
      reactProps[name === 'checked' ? 'defaultChecked' : 'defaultValue'] = value
    } else if (/^(?:aria|data)[A-Z]/.test(name)) {
      reactProps[toDashCase(name)] = value
    } else {
      reactProps[name] = value
    }
  }
  return reactProps
}

// 通用投影，不做逐标签特判：文件预览没有聊天路径的 term-* 表现层（锚点 id、
// MathRender、代码高亮等原 react-markdown 路径同样没有），`.file-tab-md` 容器样式
// 消费的正是这份裸元素流。
// comrak 的容器排版会在 blockquote/ul/ol/table/thead/tbody/tr 的子级插入 `"\n"`
// 分隔文本节点（parser.rs「容器 \n 排版」）。React 对 table 家族容器内的纯空白
// 文本节点会发 dev 告警（撞测试白名单硬断言），且它们在块级子元素之间无排版
// 语义——投影时剔除；段内软换行在文本 value 内部，不受影响。
function isContainerSeparator(node: MarkdownModelNode): boolean {
  return node.type === 'text' && node.value === '\n'
}

function renderModelNode(node: MarkdownModelNode, key: number): ReactNode {
  if (node.type === 'text') return node.value
  if (node.type === 'element') {
    const children = renderModelNodes(node.children)
    // void 元素（img/hr/br…，模型中 children 恒空）不得带 children 形参——React 对
    // 空数组同样按「void 元素带 children」抛错。
    return createElement(
      node.tagName,
      { ...modelPropertiesToReactProps(node.properties), key },
      children.length > 0 ? children : undefined,
    )
  }
  return null
}

function renderModelNodes(nodes: readonly MarkdownModelNode[]): ReactNode[] {
  return nodes.filter(node => !isContainerSeparator(node)).map(renderModelNode)
}

type MarkdownPreviewState =
  | { status: 'loading' }
  | { status: 'ready'; model: MarkdownModelRoot }
  | { status: 'error' }

/**
 * FileTabView markdown 文件预览的渲染器（#276）。
 *
 * 解析统一走 wasm 计算核（`parseMarkdown`，comrak），与聊天主链路同一实现——
 * 取代原 react-markdown + remark-gfm 的 lazy 路径（markdownLazy.tsx 已随 #276 删除）。
 * 装载是异步的；完成前渲染加载态（承接原 Suspense fallback 的可见行为）。文本变化时
 * 保留旧模型直到新解析落地（解析是毫秒级同步计算，避免加载态闪烁）。
 */
export function MarkdownPreview({ text }: { text: string }) {
  const [state, setState] = useState<MarkdownPreviewState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    loadMarkdownCompute()
      .then(compute => compute.parseMarkdown(text) as MarkdownModelRoot)
      .then(model => {
        if (!cancelled) setState({ status: 'ready', model })
      })
      .catch(error => {
        if (cancelled) return
        setState({ status: 'error' })
        reportRuntimeError('渲染 Markdown', error, undefined, {
          scope: { kind: 'sheet', id: 'file-tab:markdown-preview' },
          source: 'file.tab',
        })
      })
    return () => {
      cancelled = true
    }
  }, [text])

  if (state.status === 'error') return <p className="file-tab-hint">Markdown 渲染失败，详情见右下角错误中心</p>
  if (state.status === 'loading') return <p className="file-tab-hint">加载 Markdown…</p>
  return <>{renderModelNodes(state.model.children)}</>
}

export default MarkdownPreview
