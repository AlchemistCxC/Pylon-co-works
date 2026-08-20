import type {
  InstalledPluginPackage,
  PluginPackageClient,
  PluginPackageDescriptor,
} from '../infrastructure/plugins/pluginPackageClient.ts'
import { parsePylonPluginManifest } from './packageManifest.ts'
import {
  resolvePluginContracts,
  type PluginContract,
  type PluginContractDiagnostic,
  type PluginContractResolution,
} from './pluginContractResolver.ts'
import { PluginContractBlockedError, type PluginRuntime } from './pluginRuntime.ts'
import type { PackagePluginRuntimeService } from './packagePluginRuntime.ts'

export type PackageOperationResult =
  | { ok: true; message?: string }
  | {
    ok: false
    message: string
    code?: 'plugin_contract_blocked'
    diagnostics?: readonly PluginContractDiagnostic[]
  }

export interface PackageInitializationResult {
  activated: string[]
  failed: Array<{ pluginId: string; message: string }>
}

export interface PackageContractSnapshot {
  readonly revision: number
  readonly eligibleIds: readonly string[]
  readonly diagnostics: readonly PluginContractDiagnostic[]
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
  private readonly emittedActivationEvents = new Set<string>()
  private readonly contractListeners = new Set<() => void>()
  private contractSnapshot: PackageContractSnapshot = Object.freeze({
    revision: 0,
    eligibleIds: Object.freeze([]),
    diagnostics: Object.freeze([]),
  })

  constructor(options: PackageInstallationServiceOptions) {
    this.runtime = options.runtime
    this.packageRuntime = options.packageRuntime
    this.packages = options.packages
  }

  initialize(): Promise<PackageInitializationResult> {
    if (!this.initialization) {
      this.initialization = this.initializeOnce().catch(error => {
        this.initialization = undefined
        throw error
      })
    }
    return this.initialization
  }

  async emitActivationEvent(event: string): Promise<PackageInitializationResult> {
    if (this.emittedActivationEvents.has(event)) return this.initialize()
    const previous = this.initialization
    this.emittedActivationEvents.add(event)
    if (previous) await previous.catch(() => undefined)
    if (this.initialization === previous) this.initialization = undefined
    return this.initialize()
  }

  private async initializeOnce(): Promise<PackageInitializationResult> {
    const activated: string[] = []
    const failed: PackageInitializationResult['failed'] = []
    const installed = await this.packages.list()
    const validItems: InstalledPluginPackage[] = []
    const contracts: PluginContract[] = []
    for (const item of installed) {
      try {
        contracts.push(this.toContract(item))
        validItems.push(item)
      } catch (error) {
        if (item.enabled) failed.push({
          pluginId: item.package.pluginId,
          message: errorMessage(error),
        })
      }
    }
    const byId = new Map(validItems.map(item => [item.package.pluginId, item]))
    const resolution = this.resolveContracts(contracts)
    for (const diagnostic of resolution.blocked) {
      failed.push({ pluginId: diagnostic.pluginId, message: diagnostic.message })
    }
    for (const pluginId of resolution.eligibleIds) {
      const item = byId.get(pluginId)
      if (!item || this.isActive(pluginId)) continue
      try {
        parsePylonPluginManifest(item.package.manifest)
        await this.packageRuntime.activateInstalled(item.package)
        activated.push(pluginId)
      } catch (error) {
        failed.push({ pluginId, message: errorMessage(error) })
      }
    }
    return { activated: activated.sort(), failed }
  }

  async list(): Promise<InstalledPluginPackage[]> {
    const installed = await this.packages.list()
    this.resolveInstalled(installed)
    return installed
  }

  getContractSnapshot(): PackageContractSnapshot {
    return this.contractSnapshot
  }

  subscribeContracts(listener: () => void): () => void {
    this.contractListeners.add(listener)
    return () => { this.contractListeners.delete(listener) }
  }

  async inspect(sourcePath: string): Promise<PluginPackageDescriptor> {
    const descriptor = await this.packages.inspect(sourcePath)
    parsePylonPluginManifest(descriptor.manifest)
    return descriptor
  }

  async installOrUpdate(sourcePath: string): Promise<PackageOperationResult> {
    try {
      const descriptor = await this.inspect(sourcePath)
      const installed = await this.packages.list()
      const candidateItems = [
        ...installed.filter(item => item.package.pluginId !== descriptor.pluginId),
        { package: descriptor, enabled: true },
      ]
      const resolution = this.assertContractMutation(descriptor.pluginId, candidateItems)
      const activationEligible = resolution.eligibleIds.includes(descriptor.pluginId)
      if (this.isActive(descriptor.pluginId)) {
        await this.packageRuntime.updateFromDirectory(sourcePath, descriptor.pluginId)
      } else if (activationEligible) {
        await this.packageRuntime.activateFromDirectory(sourcePath, descriptor.pluginId)
      } else {
        const existing = installed.some(item => item.package.pluginId === descriptor.pluginId)
        if (existing) await this.packages.update(sourcePath, descriptor.pluginId)
        else await this.packages.install(sourcePath, descriptor.pluginId)
      }
      await this.packages.setEnabled(descriptor.pluginId, true)
      return { ok: true }
    } catch (error) {
      return this.operationFailure(error)
    }
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<PackageOperationResult> {
    try {
      const installed = await this.packages.list()
      const target = installed.find(item => item.package.pluginId === pluginId)
      if (!target) throw new Error(`未找到已安装包：${pluginId}`)
      const candidateItems = installed.map(item => item.package.pluginId === pluginId
        ? { ...item, enabled }
        : item)
      const resolution = this.assertContractMutation(pluginId, candidateItems)
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
      if (!this.isActive(pluginId) && resolution.eligibleIds.includes(pluginId)) {
        try {
          await this.packageRuntime.activateInstalled(target.package)
        } catch (error) {
          await this.packages.setEnabled(pluginId, false).catch(() => undefined)
          throw error
        }
      }
      return { ok: true }
    } catch (error) {
      return this.operationFailure(error)
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
    let deactivated = false
    try {
      const installed = await this.packages.list()
      this.assertContractMutation(
        pluginId,
        installed.filter(item => item.package.pluginId !== pluginId),
        [pluginId],
      )
      if (wasActive) {
        await this.runtime.disable(pluginId)
        deactivated = true
      }
      await this.packages.uninstall(pluginId, purgeData)
      return { ok: true }
    } catch (error) {
      if (deactivated) await this.runtime.enable(pluginId).catch(() => undefined)
      return this.operationFailure(error)
    }
  }

  private isActive(pluginId: string): boolean {
    return this.runtime.snapshot().active.some(identity => identity.pluginId === pluginId)
  }

  private toContract(item: InstalledPluginPackage): PluginContract {
    const manifest = parsePylonPluginManifest(item.package.manifest)
    return {
      id: item.package.pluginId,
      version: item.package.version,
      enabled: item.enabled,
      dependencies: manifest.dependencies,
      optionalDependencies: manifest.optionalDependencies,
      conflicts: manifest.conflicts,
      activationEvents: manifest.activation?.events,
    }
  }

  private resolveInstalled(
    installed: readonly InstalledPluginPackage[],
    excludedPluginIds: readonly string[] = [],
  ): PluginContractResolution {
    return this.resolveContracts(installed.map(item => this.toContract(item)), excludedPluginIds)
  }

  private resolveContracts(
    installedContracts: readonly PluginContract[],
    excludedPluginIds: readonly string[] = [],
  ): PluginContractResolution {
    const contracts = new Map<string, PluginContract>()
    const excluded = new Set(excludedPluginIds)
    for (const contract of this.runtime.contractSnapshot?.() ?? []) {
      if (excluded.has(contract.id)) continue
      contracts.set(contract.id, { ...contract, activationEvents: undefined })
    }
    for (const contract of installedContracts) contracts.set(contract.id, contract)
    const resolution = resolvePluginContracts([...contracts.values()], [...this.emittedActivationEvents])
    this.contractSnapshot = Object.freeze({
      revision: this.contractSnapshot.revision + 1,
      eligibleIds: resolution.eligibleIds,
      diagnostics: resolution.diagnostics,
    })
    for (const listener of [...this.contractListeners]) listener()
    return resolution
  }

  private assertContractMutation(
    pluginId: string,
    installed: readonly InstalledPluginPackage[],
    excludedPluginIds: readonly string[] = [],
  ): PluginContractResolution {
    const resolution = this.resolveInstalled(installed, excludedPluginIds)
    if (resolution.blocked.length > 0) {
      throw new PluginContractBlockedError(pluginId, resolution.blocked)
    }
    return resolution
  }

  private operationFailure(error: unknown): Extract<PackageOperationResult, { ok: false }> {
    if (error instanceof PluginContractBlockedError) {
      return {
        ok: false,
        code: 'plugin_contract_blocked',
        message: error.message,
        diagnostics: error.diagnostics,
      }
    }
    return { ok: false, message: errorMessage(error) }
  }
}
