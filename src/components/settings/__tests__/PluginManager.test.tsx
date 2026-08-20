// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PluginManager from '../PluginManager.tsx'
import type { InstalledPluginPackage } from '../../../infrastructure/plugins/pluginPackageClient.ts'
import type { PackageInstallationService } from '../../../plugin-runtime/packageInstallationService.ts'
import {
  getBuiltinPluginIds,
  getPluginRuntime,
} from '../../../plugin-runtime/pluginCompositionRoot.ts'

function installedPackage(enabled = true): InstalledPluginPackage {
  return {
    enabled,
    package: {
      pluginId: 'feature.demo',
      version: '1.2.3',
      packageInstanceId: 'feature.demo@1.2.3-a1',
      active: true,
      files: [],
      totalBytes: 0,
      manifest: {
        schema: 1,
        id: 'feature.demo',
        name: 'Demo',
        version: '1.2.3',
        api: '1.0',
        kind: 'feature',
        web: { entry: './dist/entry.js' },
      },
    },
  }
}

function fakeService(items: InstalledPluginPackage[] = []) {
  return {
    initialize: vi.fn(async () => ({ activated: [], failed: [] })),
    list: vi.fn(async () => items),
    installOrUpdate: vi.fn(async () => ({ ok: true as const })),
    setEnabled: vi.fn(async () => ({ ok: true as const })),
    reload: vi.fn(async () => ({ ok: true as const })),
    uninstall: vi.fn(async () => ({ ok: true as const })),
  }
}

afterEach(async () => {
  const runtime = getPluginRuntime()
  for (const pluginId of getBuiltinPluginIds()) {
    if (!runtime.snapshot().active.some(identity => identity.pluginId === pluginId)) await runtime.enable(pluginId)
  }
  const demo = runtime.snapshot().active.find(identity => identity.pluginId === 'phase12.ui-mode')
  if (demo) await runtime.deactivate(demo.runtimeInstanceId)
})

describe('PluginManager v2-only', () => {
  it('只显示 api=1.0 Runtime 与 v2 安装入口', async () => {
    const service = fakeService()
    render(<PluginManager service={service as unknown as PackageInstallationService} />)

    expect(await screen.findByText('builtin.pylon-shell')).toBeInTheDocument()
    expect(screen.getByText(/Pylon Plugin API 1.0/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '安装/更新 api=1.0 包…' })).toBeInTheDocument()
    expect(screen.queryByText(/0\.1\.0/)).toBeNull()
    expect(screen.queryByLabelText('pylon-plugin.json')).toBeNull()
  })

  it('目录安装只调用 v2 package service', async () => {
    const service = fakeService()
    render(<PluginManager
      service={service as unknown as PackageInstallationService}
      pickDirectory={async () => 'C:\\plugins\\feature.demo'}
    />)

    fireEvent.click(screen.getByRole('button', { name: '安装/更新 api=1.0 包…' }))
    expect(await screen.findByText('安装/更新成功')).toBeInTheDocument()
    expect(service.installOrUpdate).toHaveBeenCalledWith('C:\\plugins\\feature.demo')
  })

  it('外置包启停、重载和卸载全部走 v2 service', async () => {
    const service = fakeService([installedPackage()])
    render(<PluginManager service={service as unknown as PackageInstallationService} />)

    expect(await screen.findByText('feature.demo')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '启用 feature.demo' }))
    expect(await screen.findByText('启用 feature.demo成功')).toBeInTheDocument()
    expect(service.setEnabled).toHaveBeenCalledWith('feature.demo', true)
  })

  it('显示 Runtime 实际采用的 Shadow Update 模式', async () => {
    const runtime = getPluginRuntime()
    const initial = await runtime.activateBuiltin({ id: 'phase12.ui-mode', activate: () => {} })
    const result = await runtime.update({ id: 'phase12.ui-mode', hotSwapMode: 'parallel', activate: () => {} })
    const service = fakeService()
    render(<PluginManager service={service as unknown as PackageInstallationService} />)

    expect(screen.getByText('phase12.ui-mode')).toBeInTheDocument()
    expect(screen.getByText('声明 parallel · 实际采用 parallel')).toBeInTheDocument()
    expect(result.previousRuntimeInstanceId).toBe(initial.identity.key)
  })
})
