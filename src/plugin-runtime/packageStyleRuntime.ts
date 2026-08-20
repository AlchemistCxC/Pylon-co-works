import type { PluginScope } from './pluginScope.ts'

export interface PackageStyleDocument {
  readonly head: Pick<HTMLElement, 'appendChild'>
  createElement(tagName: 'link'): HTMLLinkElement
}

export type PackageStyleDocumentResolver = () => PackageStyleDocument | undefined

export interface PackageStyleHandle {
  readonly count: number
  commit(): void
}

export interface PackageStyleLoadOptions {
  readonly pluginId: string
  readonly runtimeInstanceId: string
  readonly urls: readonly string[]
  readonly scope: PluginScope
  readonly resolveDocument?: PackageStyleDocumentResolver
}

function resolveBrowserDocument(): PackageStyleDocument | undefined {
  if (typeof document === 'undefined') return undefined
  return document
}

function createStylesheet(
  documentTarget: PackageStyleDocument,
  pluginId: string,
  runtimeInstanceId: string,
  url: string,
): HTMLLinkElement {
  const link = documentTarget.createElement('link')
  link.rel = 'stylesheet'
  link.href = url
  link.dataset.pylonPluginStyle = pluginId
  link.dataset.pylonPluginRuntime = runtimeInstanceId
  link.media = 'not all'
  return link
}

function waitForStylesheet(link: HTMLLinkElement, pluginId: string, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      link.removeEventListener('load', onLoad)
      link.removeEventListener('error', onError)
    }
    const onLoad = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const onError = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(`插件 ${pluginId} 样式加载失败：${url}`))
    }
    link.addEventListener('load', onLoad)
    link.addEventListener('error', onError)
  })
}

/**
 * 把 manifest.web.styles 纳入 PluginScope：全部样式先以 `media=not all` 预加载，
 * 只有 module activation 成功后才 commit 生效；任一样式或 activation 失败时，
 * 已插入的 link 由 activation rollback 回收。
 */
export async function loadPackageStyles(options: PackageStyleLoadOptions): Promise<PackageStyleHandle> {
  if (options.urls.length === 0) return { count: 0, commit() {} }
  const documentTarget = (options.resolveDocument ?? resolveBrowserDocument)()
  if (!documentTarget) throw new Error(`插件 ${options.pluginId} 声明了 web.styles，但当前运行环境没有 DOM`)

  const links = options.urls.map(url => {
    const link = createStylesheet(documentTarget, options.pluginId, options.runtimeInstanceId, url)
    options.scope.add(() => link.remove())
    const loaded = waitForStylesheet(link, options.pluginId, url)
    documentTarget.head.appendChild(link)
    return { link, loaded }
  })
  await Promise.all(links.map(item => item.loaded))
  let committed = false
  return {
    count: links.length,
    commit() {
      if (committed) return
      committed = true
      for (const { link } of links) link.removeAttribute('media')
    },
  }
}
