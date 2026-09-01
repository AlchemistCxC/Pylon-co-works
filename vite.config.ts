import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import solid from 'vite-plugin-solid'

const SOLID_WORKBENCH_FILES = /src\/renderers\/solid-workbench\/.*\.solid(?:\.test)?\.tsx$/

/**
 * 开发浏览器的真实页面代理。
 *
 * 浏览器开发预览只能把外部页面放进跨域 iframe，父文档无法拦截其中的
 * link click；因此这里仅在 Vite dev server 上把页面原样取回、保留真实
 * HTML，并注入一个 postMessage bridge。生产构建和 Tauri 原生 WebView
 * 不经过此路由，也不会把代理当成网络访问层。
 */
function browserPreviewProxy(): Plugin {
  return {
    name: 'pylon-browser-preview-proxy',
    configureServer(server) {
      server.middlewares.use('/__pylon_browser_proxy', async (request, response, next) => {
        const query = new URL(request.url ?? '/', 'http://localhost').searchParams
        const rawTarget = query.get('url')
        if (!rawTarget) {
          response.statusCode = 400
          response.end('Missing browser preview URL')
          return
        }

        let target: URL
        try {
          target = new URL(rawTarget)
        } catch {
          response.statusCode = 400
          response.end('Invalid browser preview URL')
          return
        }
        if (target.protocol !== 'http:' && target.protocol !== 'https:') {
          response.statusCode = 400
          response.end('Only http/https browser preview URLs are supported')
          return
        }

        try {
          const upstream = await fetch(target, {
            redirect: 'follow',
            headers: { 'user-agent': 'Pylon Browser Preview' },
          })
          const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream'
          response.statusCode = upstream.status
          response.setHeader('content-type', contentType)
          response.setHeader('cache-control', 'no-store')

          if (!contentType.toLowerCase().includes('text/html')) {
            response.end(new Uint8Array(await upstream.arrayBuffer()))
            return
          }

          const html = await upstream.text()
          const finalUrl = upstream.url || target.href
          response.end(injectBrowserPreviewBridge(html, finalUrl))
        } catch (error) {
          // 交给 Vite 的错误处理中间件，开发页会看到正常的加载失败，而不是
          // 一个看似成功但内容为空的 iframe。
          next(error)
        }
      })
    },
  }
}

function injectBrowserPreviewBridge(html: string, pageUrl: string): string {
  const escapedBase = pageUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const bridge = `<script>
(() => {
  const notify = (href, action) => {
    try { parent.postMessage({ source: 'pylon-browser-preview', action, href: new URL(href, location.href).href }, '*') } catch (_) {}
  };
  window.open = (href) => {
    if (href) {
      try {
        const destination = new URL(href, location.href);
        if (destination.protocol === 'http:' || destination.protocol === 'https:') notify(destination.href, 'open-tab');
      } catch (_) {}
    }
    return null;
  };
  document.addEventListener('click', event => {
    if (event.defaultPrevented || (typeof event.button === 'number' && event.button !== 0 && event.button !== 1)) return;
    const target = event.target;
    const anchor = target instanceof Element ? target.closest('a[href]') : null;
    if (!anchor || anchor.hasAttribute('download')) return;
    let destination;
    try { destination = new URL(anchor.href, location.href); } catch (_) { return; }
    // 与桌面 WebView 的导航白名单保持一致；mailto/javascript 等页面内协议
    // 不应被预览桥接吞掉，也不应被错误地送进内部标签命令。
    if (destination.protocol !== 'http:' && destination.protocol !== 'https:') return;
    const raw = (anchor.getAttribute('href') || '').trim();
    const sameDocument = raw.startsWith('#') || (destination.origin === location.origin && destination.pathname === location.pathname && destination.search === location.search && Boolean(destination.hash));
    if (sameDocument) return;
    event.preventDefault();
    event.stopPropagation();
    notify(destination.href, (anchor.getAttribute('target') || '').toLowerCase() === '_self' ? 'navigate' : 'open-tab');
  }, true);
})();
</script>`
  const injection = `<base href="${escapedBase}">${bridge}`
  return /<head\b[^>]*>/i.test(html)
    ? html.replace(/<head\b[^>]*>/i, match => `${match}${injection}`)
    : `${injection}${html}`
}

export default defineConfig({
  plugins: [
    browserPreviewProxy(),
    solid({ include: SOLID_WORKBENCH_FILES }),
    react({ exclude: SOLID_WORKBENCH_FILES }),
  ],
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, '/')
          const firstPartyPackage = normalizedId.match(/src\/plugins\/product\/packages\/(builtin\.pylon-[^/]+)\//)?.[1]
          if (firstPartyPackage) return `first-party-${firstPartyPackage.replace('builtin.', '')}`
          if (/src\/plugins\/product\/(productPluginIds|firstPartyProductPackage|sharedLogicalActivation)\.ts$/.test(normalizedId)) {
            return 'first-party-pylon-shared'
          }
          // 首屏必需的大依赖拆独立 vendor chunk，让应用主 chunk 保持轻量（< 600 kB）
          // Match the normalized path as well as first-party packages.  Vite
          // can hand Rollup Windows-style ids; testing the raw `id` made the
          // vendor split platform-dependent and silently inflated the app
          // chunk on Windows builds.
          if (/node_modules\/(react|react-dom|scheduler)\//.test(normalizedId)) return 'vendor-react'
          if (/node_modules\/(motion|motion-dom|framer-motion)\//.test(normalizedId)) return 'vendor-motion'
        },
      },
    },
  },
})
