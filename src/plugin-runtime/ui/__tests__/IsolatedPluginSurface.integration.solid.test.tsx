// @vitest-environment jsdom
/** @jsxImportSource solid-js */
// #515：tsconfig.solid.json 的 types 列表不含 node——本文件的 esbuild spawn（node:child_process
// 等）经逐文件 triple-slash 引入 @types/node（不改共享 tsconfig）。
/// <reference types="node" />
// #515 改写点登记（迁移自 IsolatedPluginSurface.integration.test.tsx，React RTL → Solid）：
// - 被测对象改 ../IsolatedPluginSurface.solid.tsx 实体直连（原 React 薄桥零消费者，已删除；
//   props 面一致，className 同名）。
// - RTL → @solidjs/testing-library；render(() => JSX) 传函数；追加显式 afterEach cleanup()。
// - esbuild bundle / 双 root 隔离语义断言逐字保留；testTimeout 60s 配置照旧。
import { cleanup, render, waitFor } from '@solidjs/testing-library'
// @types/node is an explicit devDependency (vite peer ecology) — node: imports type-check everywhere.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { deactivatePluginInstance, type PluginInstance } from '../../pluginInstance.ts'
import { activateTestBuiltinPlugin as activateBuiltinPlugin } from '../../testing/pluginRuntimeHarness.ts'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import type { PluginUiSurface } from '../pluginUiTypes.ts'
import { IsolatedPluginSurface } from '../IsolatedPluginSurface.solid.tsx'

// P91 C2 §7：esbuild spawn/dist 构建重型套件，testTimeout 个别放宽（全局 30s）
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

declare const process: { cwd(): string; execPath: string }

interface BundledReactPlugin {
  readonly version: string
  mount: PluginUiSurface['mount']
}

const instances: PluginInstance[] = []
let alphaPlugin: BundledReactPlugin
let betaPlugin: BundledReactPlugin

// #484：react18 别名已删，双版本共存面收窄为「两个自包含 bundle（各自内联一份运行时
// 实例）」——隔离语义（独立 root、独立事件监听、卸载其一不影响另一）仍由本测试覆盖。
// #520 W4：宿主 react 系依赖退役，夹具不再内联真实 React（第三方 React 插件自带
// runtime 打包，宿主面不变）——改用自包含 DOM 运行时夹具，隔离语义与 DOM 契约
// （data-plugin-react-version 经 reactVersion deprecated 适配器）断言逐项保留。
const PLUGIN_FIXTURE_VERSION = '18.0.0-pylon-fixture'

// P91 §12 bundle 缓存：esbuild 产物按 (source + args) 内容寻址落 tmp，前后用例/运行间复用，
// 命中即跳过 spawn；加载仍走 data URL，与既有机制一致。
const BUNDLE_CACHE_DIR = join(tmpdir(), 'pylon-isolated-plugin-surface-bundles')

function cachedBundlePath(source: string, args: readonly string[]): string {
  const key = createHash('sha256').update(source).update(args.join('\u0000')).digest('hex').slice(0, 24)
  return join(BUNDLE_CACHE_DIR, `plugin-fixture-${key}.js`)
}

async function buildReactPlugin(label: string): Promise<BundledReactPlugin> {
  const source = `
        // 自包含夹具：零外部 import（宿主 node_modules 已无 react）——每次 data URL
        // 导入都是独立模块实例，闭包状态互不共享，与「各自内联一份 runtime」同语义。
        export const version = '${PLUGIN_FIXTURE_VERSION}'
        export function mount(container) {
          const button = document.createElement('button')
          let events = 0
          button.dataset.events = '0'
          const onProbe = () => {
            events += 1
            button.dataset.events = String(events)
          }
          window.addEventListener('pylon:test-plugin-ui', onProbe)
          button.textContent = 'isolated ${label} ' + version
          container.replaceChildren(button)
          return () => {
            window.removeEventListener('pylon:test-plugin-ui', onProbe)
            container.replaceChildren()
          }
        }
      `
  const args = [
    resolve('node_modules/esbuild/bin/esbuild'),
    '--bundle',
    '--format=esm',
    '--platform=browser',
    '--define:process.env.NODE_ENV="production"',
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
  ;[alphaPlugin, betaPlugin] = await Promise.all([
    buildReactPlugin('alpha'),
    buildReactPlugin('beta'),
  ])
})

afterEach(() => { cleanup() })

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
  it('runs two self-contained plugin bundles together and fully unmounts one owner', async () => {
    expect(alphaPlugin.version).toBe(PLUGIN_FIXTURE_VERSION)
    expect(betaPlugin.version).toBe(PLUGIN_FIXTURE_VERSION)
    const alpha = await installSurface('test.alpha', alphaPlugin)
    await installSurface('test.beta', betaPlugin)
    const view = render(() => <>
      <IsolatedPluginSurface surfaceId="test.alpha.surface" />
      <IsolatedPluginSurface surfaceId="test.beta.surface" />
    </>)

    expect(await view.findByText(`isolated alpha ${PLUGIN_FIXTURE_VERSION}`)).toBeInTheDocument()
    expect(await view.findByText(`isolated beta ${PLUGIN_FIXTURE_VERSION}`)).toBeInTheDocument()
    expect(view.container.querySelectorAll(`[data-plugin-react-version="${PLUGIN_FIXTURE_VERSION}"]`)).toHaveLength(2)

    window.dispatchEvent(new Event('pylon:test-plugin-ui'))
    await waitFor(() => expect(view.getByText(`isolated alpha ${PLUGIN_FIXTURE_VERSION}`)).toHaveAttribute('data-events', '1'))
    await waitFor(() => expect(view.getByText(`isolated beta ${PLUGIN_FIXTURE_VERSION}`)).toHaveAttribute('data-events', '1'))

    await deactivatePluginInstance(alpha)
    instances.splice(instances.indexOf(alpha), 1)
    await waitFor(() => expect(view.queryByText(`isolated alpha ${PLUGIN_FIXTURE_VERSION}`)).toBeNull())
    window.dispatchEvent(new Event('pylon:test-plugin-ui'))
    await waitFor(() => expect(view.getByText(`isolated beta ${PLUGIN_FIXTURE_VERSION}`)).toHaveAttribute('data-events', '2'))
  })
})
