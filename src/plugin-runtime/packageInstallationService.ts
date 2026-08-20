import type {
  InstalledPluginPackage,
  PluginPackageClient,
  PluginPackageDescriptor,
} from '../infrastructure/plugins/pluginPackageClient.ts'
import { parsePylonPluginManifest } from './packageManifest.ts'
import type { PluginRuntime } from './pluginRuntime.ts'
import type { PackagePluginRuntimeService } from './packagePluginRuntime.ts'

export type PackageOperationResult = { ok: true; message?: string } | { ok: false; message: string }

export interface PackageInitializationResult {
  activated: string[]
  failed: Array<{ pluginId: string; message: string }>
}

export interface PackageInstallationServiceOptions {
  runtime: PluginRuntime
  packageRuntime: PackagePluginRuntimeService
  packages: PluginPackageClient
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class PackageInstallationService {
  private readonly runtime: PluginRuntime
  private readonly packageRuntime: PackagePluginRuntimeService
  private readonly packages: PluginPackageClient
  private initialization: Promise<PackageInitializationResult> | undefined

  constructor(options: PackageInstallationServiceOptions) {
    this.runtime = options.runtime
    this.packageRuntime = options.packageRuntime
    this.packages = options.packages
  }

  initialize(): Promise<PackageInitializationResult> {
    if (!this.initialization) {
      this.initialization = this.initializeOnce().catch(error => {
        // 首次启动时目录/后端若尚未就绪，不能永久缓存 rejected Promise；
        // 设置页稍后刷新应能自愈重试。
        this.initialization = undefined
        throw error
      })
    }
    return this.initialization
  }

  private async initializeOnce(): Promise<PackageInitializationResult> {
    const activated: string[] = []
    const failed: PackageInitializationResult['failed'] = []
    for (const item of await this.packages.list()) {
      if (!item.enabled || this.isActive(item.package.pluginId)) continue
      try {
        parsePylonPluginManifest(item.package.manifest)
        await this.packageRuntime.activateInstalled(item.package)
        activated.push(item.package.pluginId)
      } catch (error) {
        failed.push({ pluginId: item.package.pluginId, message: errorMessage(error) })
      }
    }
    return { activated: activated.sort(), failed }
  }

  list(): Promise<InstalledPluginPackage[]> {
    return this.packages.list()
  }

  async inspect(sourcePath: string): Promise<PluginPackageDescriptor> {
    const descriptor = await this.packages.inspect(sourcePath)
    parsePylonPluginManifest(descriptor.manifest)
    return descriptor
  }

  async installOrUpdate(sourcePath: string): Promise<PackageOperationResult> {
    try {
      const descriptor = await this.inspect(sourcePath)
      if (this.isActive(descriptor.pluginId)) {
        await this.packageRuntime.updateFromDirectory(sourcePath, descriptor.pluginId)
      } else {
        await this.packageRuntime.activateFromDirectory(sourcePath, descriptor.pluginId)
      }
      await this.packages.setEnabled(descriptor.pluginId, true)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<PackageOperationResult> {
    try {
      if (!enabled) {
        if (this.isActive(pluginId)) await this.runtime.disable(pluginId)
        try {
          await this.packages.setEnabled(pluginId, false)
        } catch (error) {
          await this.runtime.enable(pluginId).catch(() => undefined)
          throw error
        }
        return { ok: true }
      }

      await this.packages.setEnabled(pluginId, true)
      if (!this.isActive(pluginId)) {
        const installed = (await this.packages.list()).find(item => item.package.pluginId === pluginId)
        if (!installed) throw new Error(`未找到已安装包：${pluginId}`)
        try {
          await this.packageRuntime.activateInstalled(installed.package)
        } catch (error) {
          await this.packages.setEnabled(pluginId, false).catch(() => undefined)
          throw error
        }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  }

  async reload(pluginId: string): Promise<PackageOperationResult> {
    try {
      await this.runtime.reload(pluginId)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  }

  async uninstall(pluginId: string, purgeData = false): Promise<PackageOperationResult> {
    const wasActive = this.isActive(pluginId)
    try {
      if (wasActive) await this.runtime.disable(pluginId)
      await this.packages.uninstall(pluginId, purgeData)
      return { ok: true }
    } catch (error) {
      if (wasActive) await this.runtime.enable(pluginId).catch(() => undefined)
      return { ok: false, message: errorMessage(error) }
    }
  }

  private isActive(pluginId: string): boolean {
    return this.runtime.snapshot().active.some(identity => identity.pluginId === pluginId)
  }
}
