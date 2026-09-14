// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react'
// @types/node is an explicit devDependency (vite peer ecology) — node: imports type-check everywhere.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { deactivatePluginInstance, type PluginInstance } from '../../pluginInstance.ts'
import { activateTestBuiltinPlugin as activateBuiltinPlugin } from '../../testing/pluginRuntimeHarness.ts'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import type { PluginUiSurface } from '../pluginUiTypes.ts'
import { IsolatedPluginSurface } from '../IsolatedPluginSurface.tsx'

// P91 C2 §7：esbuild spawn/dist 构建重型套件，testTimeout 个别放宽（全局 30s）
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

declare const process: { cwd(): string; execPath: string }

interface BundledReactPlugin {
  readonly version: string
  mount: PluginUiSurface['mount']
}

const instances: PluginInstance[] = []
let react18Plugin: BundledReactPlugin
let react19Plugin: BundledReactPlugin

// P91 批08：react18 实际版本从依赖清单派生，替代硬编码 '18.3.1'
const REACT18_VERSION = (JSON.parse(readFileSync(resolve('node_modules/react18/package.json'), 'utf8') as string) as { version: string }).version

// P91 §12 bundle 缓存：esbuild 产物按 (source + args) 内容寻址落 tmp，前后用例/运行间复用，
// 命中即跳过 spawn；加载仍走 data URL，与既有机制一致。
const BUNDLE_CACHE_DIR = join(tmpdir(), 'pylon-isolated-plugin-surface-bundles')

function cachedBundlePath(source: string, args: readonly string[]): string {
  const key = createHash('sha256').update(source).update(args.join('\u0000')).digest('hex').slice(0, 24)
  return join(BUNDLE_CACHE_DIR, `react-plugin-${key}.js`)
}

async function buildReactPlugin(alias?: Record<string, string>): Promise<BundledReactPlugin> {
  const source = `
        import React from 'react'
        import { createRoot } from 'react-dom/client'

        export const version = React.version
        export function mount(container) {
          const root = createRoot(container)
          function PluginView() {
            const [events, setEvents] = React.useState(0)
            React.useEffect(() => {
              const onProbe = () => setEvents(value => value + 1)
              window.addEventListener('pylon:test-plugin-ui', onProbe)
              return () => window.removeEventListener('pylon:test-plugin-ui', onProbe)
            }, [])
            return React.createElement(
              'button',
              { 'data-events': String(events) },
              'isolated React ' + React.version,
            )
          }
          root.render(React.createElement(PluginView))
          return () => root.unmount()
        }
      `
  const args = [
    resolve('node_modules/esbuild/bin/esbuild'),
    '--bundle',
    '--format=esm',
    '--platform=browser',
    '--define:process.env.NODE_ENV="production"',
    ...Object.entries(alias ?? {}).map(([from, to]) => `--alias:${from}=${to}`),
  ]
  const cachePath = cachedBundlePath(source, args)
  let output: Buffer
  if (existsSync(cachePath)) {
    output = readFileSync(cachePath)
  } else {
    output = execFileSync(process.execPath, args, { cwd: process.cwd(), input: source })
    mkdirSync(BUNDLE_CACHE_DIR, { recursive: true })
    writeFileSync(cachePath, output)
  }
  const dataUrl = `data:text/javascript;base64,${output.toString('base64')}`
  return import(/* @vite-ignore */ dataUrl) as Promise<BundledReactPlugin>
}

beforeAll(async () => {
  ;[react18Plugin, react19Plugin] = await Promise.all([
    buildReactPlugin({ react: 'react18', 'react-dom': 'react-dom18' }),
    buildReactPlugin(),
  ])
})

afterAll(async () => {
  while (instances.length > 0) await deactivatePluginInstance(instances.pop()!)
})

async function installSurface(id: string, plugin: BundledReactPlugin): Promise<PluginInstance> {
  const instance = await activateBuiltinPlugin(createPluginIdentity(id, 'isolated-root'), ({ ui }) => {
    ui.registerSurface({
      id: `${id}.surface`,
      reactVersion: plugin.version,
      mount: plugin.mount,
    })
  })
  instances.push(instance)
  return instance
}

describe('isolated plugin UI roots', () => {
  it('runs actual self-contained React 18 and React 19 bundles together and fully unmounts one owner', async () => {
    expect(react18Plugin.version).toBe(REACT18_VERSION)
    expect(react19Plugin.version).toMatch(/^19\./)
    const react18 = await installSurface('test.react18', react18Plugin)
    await installSurface('test.react19', react19Plugin)
    const view = render(<>
      <IsolatedPluginSurface surfaceId="test.react18.surface" />
      <IsolatedPluginSurface surfaceId="test.react19.surface" />
    </>)

    expect(await view.findByText(`isolated React ${REACT18_VERSION}`)).toBeInTheDocument()
    expect(await view.findByText(`isolated React ${react19Plugin.version}`)).toBeInTheDocument()
    expect(view.container.querySelector(`[data-plugin-react-version="${REACT18_VERSION}"]`)).not.toBeNull()
    expect(view.container.querySelector(`[data-plugin-react-version="${react19Plugin.version}"]`)).not.toBeNull()

    window.dispatchEvent(new Event('pylon:test-plugin-ui'))
    await waitFor(() => expect(view.getByText(`isolated React ${REACT18_VERSION}`)).toHaveAttribute('data-events', '1'))
    await waitFor(() => expect(view.getByText(`isolated React ${react19Plugin.version}`)).toHaveAttribute('data-events', '1'))

    await deactivatePluginInstance(react18)
    instances.splice(instances.indexOf(react18), 1)
    await waitFor(() => expect(view.queryByText(`isolated React ${REACT18_VERSION}`)).toBeNull())
    window.dispatchEvent(new Event('pylon:test-plugin-ui'))
    await waitFor(() => expect(view.getByText(`isolated React ${react19Plugin.version}`)).toHaveAttribute('data-events', '2'))
  })
})
