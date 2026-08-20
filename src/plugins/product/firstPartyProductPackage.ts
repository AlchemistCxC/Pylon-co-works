import type { BuiltinPluginDefinition } from '../../plugin-runtime/pluginRuntime.ts'
import {
  parsePylonPluginManifest,
  type PylonPluginManifest,
} from '../../plugin-runtime/packageManifest.ts'

export type FirstPartyProductPackageManifest = PylonPluginManifest & {
  readonly dependencies: Readonly<Record<string, string>>
  readonly optionalDependencies: Readonly<Record<string, string>>
  readonly conflicts: readonly string[]
  readonly activation: { readonly events: readonly string[] }
  readonly hotSwap: NonNullable<PylonPluginManifest['hotSwap']> & { readonly drainTimeoutMs: number }
}

export interface FirstPartyProductPackage {
  readonly manifest: FirstPartyProductPackageManifest
  readonly packageInstanceId: string
  readonly artifactUrl: string
  readonly createDefinition: () => BuiltinPluginDefinition
}

export function parseFirstPartyProductManifest(source: unknown): FirstPartyProductPackageManifest {
  const value = parsePylonPluginManifest(source)
  if (value.web.entry !== './entry.ts' || !value.dependencies || !value.optionalDependencies
    || !value.conflicts || !value.activation || !value.hotSwap?.drainTimeoutMs) {
    throw new Error(`第一方包 ${value.id} 缺少完整组合字段`)
  }
  return value as FirstPartyProductPackageManifest
}

function artifactFingerprint(artifactUrl: string): string {
  const fileName = artifactUrl.split('/').pop()?.replace(/\.(?:[cm]?js|tsx?|jsx?)$/i, '') ?? 'unknown'
  return fileName === 'entry' ? 'dev-source' : fileName.replace(/[^a-zA-Z0-9._-]/g, '-')
}

export function defineFirstPartyProductPackage(
  manifestSource: unknown,
  artifactUrl: string,
  createDefinition: () => BuiltinPluginDefinition,
): FirstPartyProductPackage {
  const manifest = parseFirstPartyProductManifest(manifestSource)
  const definition = createDefinition()
  if (definition.id !== manifest.id || definition.kind !== manifest.kind
    || definition.hotSwapMode !== manifest.hotSwap.mode) {
    throw new Error(`第一方包 ${manifest.id} 的 manifest 与 activation definition 不一致`)
  }
  return Object.freeze({
    manifest,
    artifactUrl,
    packageInstanceId: `${manifest.id}@${manifest.version}-${artifactFingerprint(artifactUrl)}`,
    createDefinition,
  })
}
