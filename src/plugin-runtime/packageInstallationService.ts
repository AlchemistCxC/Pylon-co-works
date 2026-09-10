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
  failed: Array<{
    pluginId: string
    message: string
    code?: string
    /** plugin_capability_denied 专属：宿主授权卡据此写入正确版本钉定的 grant。 */
    version?: string
    capabilities?: readonly string[]
  }>
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
  /** API 1.2 同意流：激活前置检查，授权缺失 → typed 失败 plugin_capability_denied。
   *  未注入时跳过（纯单测/旧路径兼容）。 */
  evaluateConsent?: (pluginId: string, version: string, capabilities?: readonly string[]) => {
    status: 'granted' | 'awaiting_consent'
    missingCapabilities: readonly string[]
  }
  /** C2 授权回收：卸载成功后回调（宿主注入 grant revoke）。 */
  onUninstalled?: (pluginId: string) => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 外置包同意流 typed 失败（review P2-2/A：从 message 前缀升级为结构化 code）。 */
export class PluginCapabilityDeniedError extends Error {
  readonly code = 'plugin_capability_denied'
  constructor(
    readonly pluginId: string,
    message: string,
  ) {
    super(message)
    this.name = 'PluginCapabilityDeniedError'
  }
}

export class PackageInstallationService {
  private readonly runtime: PluginRuntime
  private readonly packageRuntime: PackagePluginRuntimeService
  private readonly packages: PluginPackageClient
  private readonly evaluateConsent: PackageInstallationServiceOptions['evaluateConsent']
  private readonly onUninstalled: PackageInstallationServiceOptions['onUninstalled']
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
    this.evaluateConsent = options.evaluateConsent
    this.onUninstalled = options.onUninstalled
  }

  /** 激活前置同意检查：声明 capability 且授权缺失 → typed 失败（不抛异常，进 failed 列表）。 */
  private assertCapabilityConsent(
    pluginId: string,
    version: string,
    capabilities: readonly string[] | undefined,
  ): void {
    if (!this.evaluateConsent || !capabilities || capabilities.length === 0) return
    const consent = this.evaluateConsent(pluginId, version, capabilities)
    if (consent.status === 'awaiting_consent') {
      throw new PluginCapabilityDeniedError(
        pluginId,
        `plugin_capability_denied: 插件 ${pluginId} 等待能力授权（${consent.missingCapabilities.join(', ')}）`,
      )
    }
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
    // 重复事件 = 显式重新评估请求（外置 capability 包授权后的 retryPlugin
    // 依赖此路径绕过 initialize 缓存，review B P1-1）；重跑幂等——
    // initializeOnce 对已激活包由 isActive 跳过。
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
        const manifest = parsePylonPluginManifest(item.package.manifest)
        this.assertCapabilityConsent(item.package.pluginId, item.package.version, manifest.capabilities)
        await this.packageRuntime.activateInstalled(item.package)
        activated.push(pluginId)
      } catch (error) {
        const parsed = parsePylonPluginManifest(item.package.manifest)
        failed.push({
          pluginId,
          message: errorMessage(error),
          ...(error instanceof PluginCapabilityDeniedError ? { code: error.code } : {}),
          // 授权卡元数据（review B P1-1）：外置包授权通路依赖 version/capabilities
          version: parsed.version,
          capabilities: parsed.capabilities ? [...parsed.capabilities] : undefined,
        })
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
      return await this.installDescriptor(sourcePath, descriptor)
    } catch (error) {
      return this.operationFailure(error)
    }
  }

  /** P53 D6：从本机 zip 安装/更新（inspect zip → 契约/consent → installFromZip）。 */
  async installOrUpdateFromZip(zipPath: string): Promise<PackageOperationResult> {
    try {
      const descriptor = await this.packages.inspectZip(zipPath)
      parsePylonPluginManifest(descriptor.manifest)
      return await this.installDescriptor(zipPath, descriptor, 'zip')
    } catch (error) {
      return this.operationFailure(error)
    }
  }

  /** P53 D6：从 https URL 安装/更新（inspect url → 契约/consent → installFromUrl）。 */
  async installOrUpdateFromUrl(url: string): Promise<PackageOperationResult> {
    try {
      const descriptor = await this.packages.inspectUrl(url)
      parsePylonPluginManifest(descriptor.manifest)
      return await this.installDescriptor(url, descriptor, 'url')
    } catch (error) {
      return this.operationFailure(error)
    }
  }

  /**
   * 安装已解析的 descriptor（目录/zip/url 三源共用）：契约变更检查、consent
   * 前置检查、激活分支（active→shadow update 仅目录；zip/url 走原子安装后
   * 重启用）、install-only 分支。source 传递给对应 client 方法。
   */
  private async installDescriptor(
    source: string,
    descriptor: PluginPackageDescriptor,
    kind: 'directory' | 'zip' | 'url' = 'directory',
  ): Promise<PackageOperationResult> {
    try {
      const installed = await this.packages.list()
      const candidateItems = [
        ...installed.filter(item => item.package.pluginId !== descriptor.pluginId),
        { package: descriptor, enabled: true },
      ]
      const resolution = this.assertContractMutation(descriptor.pluginId, candidateItems)
      const activationEligible = resolution.eligibleIds.includes(descriptor.pluginId)
      const manifest = parsePylonPluginManifest(descriptor.manifest)
      if (activationEligible) {
        this.assertCapabilityConsent(descriptor.pluginId, descriptor.version, manifest.capabilities)
      }
      const installSource = async (): Promise<void> => {
        if (kind === 'zip') await this.packages.installFromZip(source, descriptor.pluginId)
        else if (kind === 'url') await this.packages.installFromUrl(source, descriptor.pluginId)
        else if (this.isActive(descriptor.pluginId)) {
          await this.packageRuntime.updateFromDirectory(source, descriptor.pluginId)
        } else if (activationEligible) {
          await this.packageRuntime.activateFromDirectory(source, descriptor.pluginId)
        } else {
          const existing = installed.some(item => item.package.pluginId === descriptor.pluginId)
          if (existing) await this.packages.update(source, descriptor.pluginId)
          else await this.packages.install(source, descriptor.pluginId)
        }
      }
      if (this.isActive(descriptor.pluginId) && kind !== 'directory') {
        // zip/url 更新是原子版本替换：先停用旧 runtime，装完再激活新版本
        const cleanup = await this.runtime.disable(descriptor.pluginId)
        if (!cleanup.complete) throw new Error(this.cleanupFailureMessage(descriptor.pluginId, cleanup))
        try {
          await installSource()
        } catch (error) {
          await this.runtime.enable(descriptor.pluginId).catch(() => undefined)
          throw error
        }
      } else {
        await installSource()
      }
      await this.packages.setEnabled(descriptor.pluginId, true)
      if (kind !== 'directory' && resolution.eligibleIds.includes(descriptor.pluginId)
        && !this.isActive(descriptor.pluginId)) {
        const target = (await this.packages.list()).find(item => item.package.pluginId === descriptor.pluginId)
        if (target) {
          // review P1-2（C）：inspect 与 install 是两次独立获取（URL/zip 内容
          // 可被中途替换），consent 必须对"已落库"的 manifest 复查——不许
          // 良性探查换来恶意包激活。
          try {
            const installedManifest = parsePylonPluginManifest(target.package.manifest)
            this.assertCapabilityConsent(
              target.package.pluginId,
              target.package.version,
              installedManifest.capabilities,
            )
          } catch (error) {
            await this.packages.setEnabled(descriptor.pluginId, false).catch(() => undefined)
            throw error
          }
          try {
            await this.packageRuntime.activateInstalled(target.package)
          } catch (error) {
            // 对称回滚（review P2-6）：与 setEnabled(false) 路径一致
            await this.packages.setEnabled(descriptor.pluginId, false).catch(() => undefined)
            throw error
          }
        }
      }
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
        this.assertNoIncompleteCleanup(pluginId)
        if (this.isActive(pluginId)) {
          const cleanup = await this.runtime.disable(pluginId)
          if (!cleanup.complete) throw new Error(this.cleanupFailureMessage(pluginId, cleanup))
        }
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
          this.assertCapabilityConsent(
            pluginId,
            target.package.version,
            parsePylonPluginManifest(target.package.manifest).capabilities,
          )
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
      this.assertNoIncompleteCleanup(pluginId)
      if (wasActive) {
        const cleanup = await this.runtime.disable(pluginId)
        if (!cleanup.complete) throw new Error(this.cleanupFailureMessage(pluginId, cleanup))
        deactivated = true
      }
      await this.packages.uninstall(pluginId, purgeData)
      // C2 授权回收：卸载成功即回收该插件全部能力授权（重装须重新同意）
      this.onUninstalled?.(pluginId)
      return { ok: true }
    } catch (error) {
      if (deactivated) await this.runtime.enable(pluginId).catch(() => undefined)
      return this.operationFailure(error)
    }
  }

  private isActive(pluginId: string): boolean {
    return this.runtime.snapshot().active.some(identity => identity.pluginId === pluginId)
  }

  private assertNoIncompleteCleanup(pluginId: string): void {
    const residuals = this.runtime.snapshot().instances.filter(instance => (
      instance.identity.pluginId === pluginId && instance.status !== 'active'
    ))
    if (residuals.length === 0) return
    const errors = residuals.flatMap(instance => [
      instance.cleanup?.deactivateError?.message,
      ...(instance.cleanup?.scope.errors.map(error => error.message) ?? []),
    ]).filter((message): message is string => Boolean(message))
    throw new Error(`插件 ${pluginId} 仍有未完成清理：${errors.join('；') || '请先重试清理残留资源'}`)
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

  private cleanupFailureMessage(
    pluginId: string,
    result: Awaited<ReturnType<PluginRuntime['disable']>>,
  ): string {
    const errors = [
      result.deactivateError?.message,
      ...result.scope.errors.map(error => error.message),
    ].filter((message): message is string => Boolean(message))
    return `插件 ${pluginId} 清理未完成：${errors.join('；') || `${result.scope.remaining} 个资源残留`}`
  }
}
