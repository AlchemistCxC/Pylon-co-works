// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PluginManager from '../PluginManager.tsx'
import type { InstalledPluginPackage } from '../../../infrastructure/plugins/pluginPackageClient.ts'
import type { PackageInstallationService } from '../../../plugin-runtime/packageInstallationService.ts'
import type { KernelBootstrap } from '../../../kernel/kernelBootstrap.ts'
import {
  bootstrapBuiltins,
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
  const contractSnapshot = {
    revision: 0,
    eligibleIds: [] as readonly string[],
    diagnostics: [] as readonly {
      pluginId: string
      code: 'waiting_activation'
      message: string
      blocking: boolean
      relatedPluginIds: readonly string[]
    }[],
  }
  return {
    initialize: vi.fn(async () => ({ activated: [], failed: [] })),
    list: vi.fn(async () => items),
    installOrUpdate: vi.fn(async () => ({ ok: true as const })),
    setEnabled: vi.fn(async () => ({ ok: true as const })),
    reload: vi.fn(async () => ({ ok: true as const })),
    uninstall: vi.fn(async () => ({ ok: true as const })),
    getContractSnapshot: vi.fn(() => contractSnapshot),
    subscribeContracts: vi.fn(() => () => undefined),
  }
}

beforeEach(async () => {
  await bootstrapBuiltins('normal')
})

afterEach(async () => {
  const runtime = getPluginRuntime()
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
    const service = fakeService([installedPackage(false)])
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

  it('does not offer ordinary disable for product-required builtins', async () => {
    await bootstrapBuiltins('normal')
    const service = fakeService()

    render(<PluginManager service={service as unknown as PackageInstallationService} />)

    expect(screen.getByRole('button', { name: '停用 builtin.pylon-shell' })).toBeDisabled()
    expect(screen.getAllByText('产品运行必需')).toHaveLength(5)
  })

  it('shows degraded bootstrap failures and delegates explicit retry to the Kernel supervisor', async () => {
    const failure = {
      pluginId: 'builtin.pylon-shell',
      stage: 'activate' as const,
      code: 'plugin_activation_failed',
      message: 'shell entry rejected',
      retryable: true,
    }
    const retryPlugin = vi.fn(async () => undefined)
    const snapshot = {
      kind: 'degraded' as const,
      activePluginIds: [],
      failures: [failure],
      skippedPluginIds: [],
    }
    const bootstrap: KernelBootstrap = {
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
      startNormal: vi.fn(async () => undefined),
      startSafeMode: vi.fn(async () => undefined),
      retryPlugin,
    }

    render(<PluginManager
      service={fakeService() as unknown as PackageInstallationService}
      bootstrap={bootstrap}
    />)

    expect(screen.getByText(/shell entry rejected/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试 builtin.pylon-shell' }))
    expect(retryPlugin).toHaveBeenCalledWith('builtin.pylon-shell')
  })

  it('routes builtin enable through the Kernel dependency-closure retry action', async () => {
    const retryPlugin = vi.fn(async () => undefined)
    const snapshot = {
      kind: 'safe-mode' as const,
      skippedPluginIds: ['builtin.skin'],
    }
    const bootstrap: KernelBootstrap = {
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
      startNormal: vi.fn(async () => undefined),
      startSafeMode: vi.fn(async () => undefined),
      retryPlugin,
    }
    await bootstrapBuiltins('safe-mode')

    render(<PluginManager
      service={fakeService() as unknown as PackageInstallationService}
      bootstrap={bootstrap}
    />)
    fireEvent.click(screen.getByRole('button', { name: '启用 builtin.skin' }))

    expect(await screen.findByText('启用 builtin.skin成功')).toBeInTheDocument()
    expect(retryPlugin).toHaveBeenCalledWith('builtin.skin')
  })

  it('distinguishes an enabled package waiting for an activation event', async () => {
    const service = fakeService([installedPackage()])
    service.getContractSnapshot.mockReturnValue({
      revision: 1,
      eligibleIds: [],
      diagnostics: [{
        pluginId: 'feature.demo',
        code: 'waiting_activation',
        message: '等待激活事件：workspace.opened',
        blocking: false,
        relatedPluginIds: [],
      }],
    })

    render(<PluginManager service={service as unknown as PackageInstallationService} />)

    expect(await screen.findByText('等待激活事件')).toBeInTheDocument()
    expect(screen.getByText('等待激活事件：workspace.opened')).toBeInTheDocument()
  })
})
