/** Typed v2 boundary for binary package storage and resource streaming. */
import { convertFileSrc, isTauri } from '@tauri-apps/api/core'
import type { PylonPluginManifest } from '../../plugin-runtime/packageManifest.ts'
import type { ClientTransport } from './pluginClientTransport.ts'

export interface PluginFileMetadata {
  path: string
  size: number
  mime: string
}

export interface PluginPackageDescriptor {
  pluginId: string
  version: string
  packageInstanceId: string
  manifest: PylonPluginManifest
  files: PluginFileMetadata[]
  totalBytes: number
  active: boolean
}

export interface PluginPackageOperationResult {
  operationId: string
  package: PluginPackageDescriptor
  previousActive?: string
}

export interface InstalledPluginPackage {
  package: PluginPackageDescriptor
  enabled: boolean
}

export interface PluginPackageClientOptions {
  transport: ClientTransport
  fetch?: typeof globalThis.fetch
  /** Test/browser adapter; production uses Tauri's platform-aware protocol URL conversion. */
  convertResourceUrl?: (canonicalUrl: string) => string
}

function platformResourceUrl(canonicalUrl: string): string {
  if (!isTauri()) return canonicalUrl
  const canonical = new URL(canonicalUrl)
  const resourcePath = decodeURIComponent(canonical.pathname.replace(/^\//, ''))
  const converted = convertFileSrc(resourcePath, 'pylon-plugin')
    .replaceAll(/%2F/gi, '/')
    .replaceAll(/%40/gi, '@')
  return `${converted}${canonical.search}`
}

export function createPluginPackageClient(options: PluginPackageClientOptions) {
  const { transport } = options
  const fetchResource = options.fetch ?? globalThis.fetch.bind(globalThis)
  const convertResourceUrl = options.convertResourceUrl ?? platformResourceUrl

  async function resourceUrl(
    packageInstanceId: string,
    path: string,
    runtimeInstanceId?: string,
  ): Promise<string> {
    const canonical = await transport.invoke('plugin_package_resource_url', {
      packageInstanceId,
      path,
      runtimeInstanceId,
    }) as string
    return convertResourceUrl(canonical)
  }

  async function fetchChecked(url: string, init?: RequestInit): Promise<Response> {
    const response = await fetchResource(url, init)
    if (!response.ok) {
      throw new Error(`插件资源读取失败：HTTP ${response.status}`)
    }
    return response
  }

  return {
    inspect: (sourcePath: string): Promise<PluginPackageDescriptor> =>
      transport.invoke('plugin_package_inspect', { sourcePath }) as Promise<PluginPackageDescriptor>,
    install: (sourcePath: string, expectedId: string): Promise<PluginPackageOperationResult> =>
      transport.invoke('plugin_package_install', { sourcePath, expectedId }) as Promise<PluginPackageOperationResult>,
    update: (sourcePath: string, expectedId: string): Promise<PluginPackageOperationResult> =>
      transport.invoke('plugin_package_update', { sourcePath, expectedId }) as Promise<PluginPackageOperationResult>,
    stage: (sourcePath: string, expectedId: string): Promise<PluginPackageOperationResult> =>
      transport.invoke('plugin_package_stage', { sourcePath, expectedId }) as Promise<PluginPackageOperationResult>,
    commitStage: (operationId: string): Promise<PluginPackageOperationResult> =>
      transport.invoke('plugin_package_stage_commit', { operationId }) as Promise<PluginPackageOperationResult>,
    abortStage: (operationId: string): Promise<void> =>
      transport.invoke('plugin_package_stage_abort', { operationId }) as Promise<void>,
    versions: (pluginId: string): Promise<PluginPackageDescriptor[]> =>
      transport.invoke('plugin_package_versions', { pluginId }) as Promise<PluginPackageDescriptor[]>,
    list: (): Promise<InstalledPluginPackage[]> =>
      transport.invoke('plugin_package_list') as Promise<InstalledPluginPackage[]>,
    setEnabled: (pluginId: string, enabled: boolean): Promise<void> =>
      transport.invoke('plugin_package_set_enabled', { pluginId, enabled }) as Promise<void>,
    rollback: (pluginId: string, packageInstanceId?: string): Promise<PluginPackageOperationResult> =>
      transport.invoke('plugin_package_rollback', { pluginId, packageInstanceId }) as Promise<PluginPackageOperationResult>,
    uninstall: (pluginId: string, purgeData = false): Promise<void> =>
      transport.invoke('plugin_package_uninstall', { pluginId, purgeData }) as Promise<void>,
    readText: (packageInstanceId: string, path: string): Promise<string> =>
      transport.invoke('plugin_package_read_text', { packageInstanceId, path }) as Promise<string>,
    resourceUrl,
    /** Large files stay outside JSON invoke; consumers read the response stream directly. */
    async openStream(packageInstanceId: string, path: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
      const response = await fetchChecked(await resourceUrl(packageInstanceId, path), { signal })
      if (!response.body) throw new Error('插件资源响应不支持流式读取')
      return response.body
    },
    /** Range reads permit bounded random access to models, WASM and other large assets. */
    async readRange(packageInstanceId: string, path: string, start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
        throw new RangeError('无效的插件资源字节范围')
      }
      const response = await fetchChecked(await resourceUrl(packageInstanceId, path), {
        headers: { Range: `bytes=${start}-${end}` },
        signal,
      })
      return new Uint8Array(await response.arrayBuffer())
    },
    createRuntime: (runtimeInstanceId: string): Promise<void> =>
      transport.invoke('plugin_runtime_create', { runtimeInstanceId }) as Promise<void>,
    cleanupRuntime: (runtimeInstanceId: string): Promise<void> =>
      transport.invoke('plugin_runtime_cleanup', { runtimeInstanceId }) as Promise<void>,
  }
}

export type PluginPackageClient = ReturnType<typeof createPluginPackageClient>
