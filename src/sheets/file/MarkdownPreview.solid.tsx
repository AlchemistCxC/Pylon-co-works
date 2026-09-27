import { createEffect, createSignal, onCleanup, Show } from 'solid-js'
import { render } from 'solid-js/web'
import {
  loadMarkdownCompute,
  type MarkdownModelElement,
  type MarkdownModelNode,
  type MarkdownModelRoot,
} from '../../infrastructure/compute/markdownCompute.ts'
import { reportRuntimeError } from '../../app/runtimeError.ts'

// hast 语义属性名（camelCase）→ Solid 属性名：aria/data 家族需连字符小写化；
// className 数组拍平为 class；checked/value 原样（Solid 无受控告警概念，非受控投影
// 的 React 侧特判在此不适用）。
function toDashCase(name: string): string {
  return name.replace(/[A-Z]/g, character => `-${character.toLowerCase()}`)
}

function modelPropertiesToElementProps(properties: MarkdownModelElement['properties']): Record<string, unknown> {
  const elementProps: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(properties)) {
    if (value === undefined || value === null) continue
    if (name === 'className') {
      const className = Array.isArray(value) ? value.join(' ') : String(value)
      if (className !== '') elementProps.class = className
    } else if (/^(?:aria|data)[A-Z]/.test(name)) {
      elementProps[toDashCase(name)] = value
    } else {
      elementProps[name] = value
    }
  }
  return elementProps
}

// comrak 的容器排版会在 blockquote/ul/ol/table 家族子级插入 `"\n"` 分隔文本节点；
// 它们在块级子元素之间无排版语义，投影时剔除（段内软换行在文本 value 内部，不受影响）。
function isContainerSeparator(node: MarkdownModelNode): boolean {
  return node.type === 'text' && node.value === '\n'
}

/**
 * 模型 → DOM 直绘投影：解析产物是每次落地即冻结的静态树（模型级缓存持有），无需
 * 响应式插入，直接 createElement/setAttribute 即可。属性语义与 React 版投影一致：
 * class 拍平、aria/data 连字符化、布尔属性按空值属性呈现、href/src/align 原样。
 */
function renderModelDom(node: MarkdownModelNode): Node {
  if (node.type === 'text') return document.createTextNode(node.value)
  const element = document.createElement(node.tagName)
  for (const [name, value] of Object.entries(modelPropertiesToElementProps(node.properties))) {
    if (name === 'class') element.setAttribute('class', String(value))
    // 布尔 true 落 "true" 值属性（对齐 React 版 data-footnote-ref="true" 的形状契约）；
    // 布尔 false 不落属性（checked="false" 在 HTML 语义里仍为真）
    else if (value === true) element.setAttribute(name, 'true')
    else if (value === false) continue
    else element.setAttribute(name, String(value))
  }
  for (const child of node.children) {
    if (!isContainerSeparator(child)) element.appendChild(renderModelDom(child))
  }
  return element
}

export interface MarkdownPreviewProps {
  /** 响应式：text 变化触发重解析（保留旧模型直到新解析落地，避免加载态闪烁）。 */
  latest: () => { text: string }
}

/**
 * FileTabView markdown 文件预览的 Solid 实体（#279 第 2 梯队）。
 *
 * 解析统一走 wasm 计算核（`parseMarkdown`，comrak），与聊天主链路同一实现。装载是
 * 异步的；完成前渲染加载态。文本变化时保留旧模型直到新解析落地。失败经
 * `reportRuntimeError` 上报 + 失败态文案，不吞错。
 */
export default function MarkdownPreview(p: MarkdownPreviewProps) {
  const [model, setModel] = createSignal<MarkdownModelRoot | null>(null)
  const [failed, setFailed] = createSignal(false)

  createEffect(() => {
    const text = p.latest().text
    let cancelled = false
    loadMarkdownCompute()
      .then(compute => compute.parseMarkdown(text) as MarkdownModelRoot)
      .then(parsed => {
        if (cancelled) return
        setFailed(false)
        setModel(parsed)
      })
      .catch(error => {
        if (cancelled) return
        setFailed(true)
        setModel(null)
        reportRuntimeError('渲染 Markdown', error, undefined, {
          scope: { kind: 'sheet', id: 'file-tab:markdown-preview' },
          source: 'file.tab',
        })
      })
    onCleanup(() => { cancelled = true })
  })

  let hostElement: HTMLDivElement | undefined

  createEffect(() => {
    const root = model()
    if (!hostElement) return
    if (!root) { hostElement.replaceChildren(); return }
    hostElement.replaceChildren(...root.children.filter(node => !isContainerSeparator(node)).map(renderModelDom))
  })

  return (
    <Show when={!failed()} fallback={<p class="file-tab-hint">Markdown 渲染失败，详情见右下角错误中心</p>}>
      <Show when={model()} fallback={<p class="file-tab-hint">加载 Markdown…</p>}>
        <div ref={element => { hostElement = element }} />
      </Show>
    </Show>
  )
}

/** React 薄桥（MarkdownPreview.tsx）的挂载工厂：Solid JSX 只允许出现在本文件。 */
export function renderMarkdownPreview(container: HTMLElement, latest: () => { text: string }): () => void {
  return render(() => <MarkdownPreview latest={latest} />, container)
}
