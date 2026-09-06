import type { PluginPackageClient, PluginPackageDescriptor } from '../infrastructure/plugins/pluginPackageClient.ts'
import type { BuiltinPluginActivationContext } from './pluginActivationContext.ts'
import { createPackagePluginIdentity } from './pluginIdentity.ts'
import type { BuiltinPluginDefinition, PluginRuntime } from './pluginRuntime.ts'
import type { HotSwapMode, PluginUpdateResult } from './shadowUpdate.ts'
import { parsePylonPluginManifest, type PylonPluginCapability } from './packageManifest.ts'
import { loadPackageStyles, type PackageStyleHandle } from './packageStyleRuntime.ts'

export interface PackagePluginModule {
  prepare?: (context: BuiltinPluginActivationContext) => unknown | Promise<unknown>
  activate: (context: BuiltinPluginActivationContext, prepared?: unknown) => void | Promise<void>
  suspend?: () => void | Promise<void>
  resume?: () => void | Promise<void>
  deactivate?: () => void | Promise<void>
}

interface PreparedPackagePlugin {
  readonly modulePrepared: unknown
  readonly styles: PackageStyleHandle
}

export interface PackagePluginRuntimeOptions {
  runtime: PluginRuntime
  packages: PluginPackageClient
  importEntry?: (url: string) => Promise<unknown>
  createRuntimeId?: (packageInstanceId: string) => string
}

export interface PackagePluginUpdateResult extends PluginUpdateResult {
  readonly operationId: string
  readonly package: PluginPackageDescriptor
}

export interface PackagePluginActivationResult {
  readonly operationId: string
  readonly package: PluginPackageDescriptor
  readonly runtimeInstanceId: string
}

function normalizeModule(value: unknown, pluginId: string): PackagePluginModule {
  const candidate = (value && typeof value === 'object'
    ? (value as { default?: unknown }).default
    : undefined) ?? value
  if (!candidate || typeof (candidate as { activate?: unknown }).activate !== 'function') {
    throw new Error(`插件 ${pluginId} 入口未导出 activate`)
  }
  return candidate as PackagePluginModule
}

export class PackagePluginRuntimeService {
  private readonly runtime: PluginRuntime
  private readonly packages: PluginPackageClient
  private readonly importEntry: (url: string) => Promise<unknown>
  private readonly createRuntimeId: (packageInstanceId: string) => string
  private runtimeSequence = 0

  constructor(options: PackagePluginRuntimeOptions) {
    this.runtime = options.runtime
    this.packages = options.packages
    this.importEntry = options.importEntry ?? (url => import(/* @vite-ignore */ url))
    this.createRuntimeId = options.createRuntimeId
      ?? (packageId => `${packageId}#run-${Date.now()}-${++this.runtimeSequence}`)
  }

  async activateFromDirectory(sourcePath: string, expectedId: string): Promise<PackagePluginActivationResult> {
    const staged = await this.packages.stage(sourcePath, expectedId)
    let runtimeInstanceId: string | undefined
    try {
      runtimeInstanceId = this.createRuntimeId(staged.package.packageInstanceId)
      const definition = await this.loadDefinition(staged.package, runtimeInstanceId)
      const identity = createPackagePluginIdentity({
        pluginId: staged.package.pluginId,
        version: staged.package.version,
        packageInstanceId: staged.package.packageInstanceId,
        runtimeInstanceId,
      })
      await this.runtime.activatePackage(definition, identity)
      await this.packages.commitStage(staged.operationId)
      return { operationId: staged.operationId, package: staged.package, runtimeInstanceId }
    } catch (error) {
      if (runtimeInstanceId) await this.runtime.deactivate(runtimeInstanceId).catch(() => undefined)
      await this.packages.abortStage(staged.operationId).catch(() => undefined)
      throw error
    }
  }

  async activateInstalled(descriptor: PluginPackageDescriptor): Promise<PackagePluginActivationResult> {
    const runtimeInstanceId = this.createRuntimeId(descriptor.packageInstanceId)
    const definition = await this.loadDefinition(descriptor, runtimeInstanceId)
    const identity = createPackagePluginIdentity({
      pluginId: descriptor.pluginId,
      version: descriptor.version,
      packageInstanceId: descriptor.packageInstanceId,
      runtimeInstanceId,
    })
    await this.runtime.activatePackage(definition, identity)
    return { operationId: `startup:${descriptor.packageInstanceId}`, package: descriptor, runtimeInstanceId }
  }

  async updateFromDirectory(sourcePath: string, expectedId: string): Promise<PackagePluginUpdateResult> {
    const staged = await this.packages.stage(sourcePath, expectedId)
    try {
      const runtimeInstanceId = this.createRuntimeId(staged.package.packageInstanceId)
      const definition = await this.loadDefinition(staged.package, runtimeInstanceId)
      const identity = createPackagePluginIdentity({
        pluginId: staged.package.pluginId,
        version: staged.package.version,
        packageInstanceId: staged.package.packageInstanceId,
        runtimeInstanceId,
      })
      const result = await this.runtime.update(definition, {
        identity,
        commitActivePointer: async () => { await this.packages.commitStage(staged.operationId) },
      })
      return { ...result, operationId: staged.operationId, package: staged.package }
    } catch (error) {
      await this.packages.abortStage(staged.operationId).catch(() => undefined)
      throw error
    }
  }

  private async loadDefinition(
    descriptor: PluginPackageDescriptor,
    runtimeInstanceId: string,
  ): Promise<BuiltinPluginDefinition> {
    const manifest = parsePylonPluginManifest(descriptor.manifest)
    const entryUrl = await this.packages.resourceUrl(
      descriptor.packageInstanceId,
      manifest.web.entry,
      runtimeInstanceId,
    )
    const styleUrls = await Promise.all((manifest.web.styles ?? []).map(path => (
      this.packages.resourceUrl(descriptor.packageInstanceId, path, runtimeInstanceId)
    )))
    const module = normalizeModule(await this.importEntry(entryUrl), descriptor.pluginId)
    const hotSwapMode = (manifest.hotSwap?.mode ?? 'parallel') as HotSwapMode
    return {
      id: descriptor.pluginId,
      kind: manifest.kind,
      dependencies: Object.freeze({ ...manifest.dependencies }),
      optionalDependencies: Object.freeze({ ...manifest.optionalDependencies }),
      conflicts: Object.freeze([...(manifest.conflicts ?? [])]),
      activationEvents: Object.freeze([...(manifest.activation?.events ?? [])]),
      version: descriptor.version,
      packageInstanceId: descriptor.packageInstanceId,
      runtimeInstanceId,
      hotSwapMode,
      drainTimeoutMs: manifest.hotSwap?.drainTimeoutMs,
      // 解析器已保证词表封闭；窄化到 capability 字面量类型
      capabilities: manifest.capabilities?.map(capability => capability as PylonPluginCapability),
      dangerousHooks: Object.freeze([...(manifest.dangerousHooks ?? [])]),
      prepare: async context => {
        await this.packages.createRuntime(runtimeInstanceId)
        context.scope.add(() => this.packages.cleanupRuntime(runtimeInstanceId))
        const styles = await loadPackageStyles({
          pluginId: descriptor.pluginId,
          runtimeInstanceId,
          urls: styleUrls,
          scope: context.scope,
        })
        return {
          styles,
          modulePrepared: await module.prepare?.(context),
        } satisfies PreparedPackagePlugin
      },
      activate: async (context, prepared) => {
        const packagePrepared = prepared as PreparedPackagePlugin
        await module.activate(context, packagePrepared.modulePrepared)
        packagePrepared.styles.commit()
      },
      suspend: module.suspend,
      resume: module.resume,
      deactivate: module.deactivate,
    }
  }
}
