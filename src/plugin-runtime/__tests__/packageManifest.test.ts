import { describe, expect, it } from 'vitest'
import {
  parsePylonPluginManifest,
  PluginManifestError,
  PYLON_PLUGIN_API_LATEST,
  PYLON_PLUGIN_API_MIN,
  PYLON_PLUGIN_API_SUPPORTED,
  PYLON_PLUGIN_API_VERSION,
  PYLON_PLUGIN_CAPABILITIES,
} from '../packageManifest.ts'

const valid = {
  schema: 1,
  id: 'feature.example',
  name: 'Example',
  version: '1.0.0',
  api: PYLON_PLUGIN_API_VERSION,
  kind: 'feature',
  web: { entry: './dist/entry.js', styles: ['./dist/style.css'] },
  dependencies: {},
  hotSwap: { mode: 'parallel', drainTimeoutMs: 10000 },
}

describe('api=1.0 package manifest', () => {
  it('accepts the schema-1 v2 shape', () => {
    expect(parsePylonPluginManifest(valid)).toEqual(valid)
  })

  it('rejects the deleted api=0.1 shape', () => {
    expect(() => parsePylonPluginManifest({
      id: 'legacy.example', api: '0.1.0', trust: 'dev', entry: 'index.js', capabilities: [], contributes: [],
    })).toThrow(/trust.*API 1\.0/)
  })

  it.each(['trust', 'capabilities', 'contributes', 'signature', 'entry'])(
    'rejects removed field %s even on a schema-1 manifest',
    removed => {
      expect(() => parsePylonPluginManifest({ ...valid, [removed]: 'legacy' }))
        .toThrow(new RegExp(`${removed}.*API 1\\.0`))
    },
  )

  it('rejects unsupported dependency ranges with a stable manifest error', () => {
    expect(() => parsePylonPluginManifest({
      ...valid,
      dependencies: { 'service.clock': '>=1.0.0' },
    })).toThrow(expect.objectContaining<Partial<PluginManifestError>>({
      name: 'PluginManifestError',
      code: 'plugin_manifest_invalid',
      field: 'dependencies.service.clock',
    }))
  })

  it('rejects invalid dependency ids before contract resolution', () => {
    expect(() => parsePylonPluginManifest({
      ...valid,
      dependencies: { 'Not A Plugin': '*' },
    })).toThrow(expect.objectContaining<Partial<PluginManifestError>>({
      code: 'plugin_manifest_invalid',
      field: 'dependencies.Not A Plugin',
    }))
  })

  it('rejects self-conflicts with a stable field diagnostic', () => {
    expect(() => parsePylonPluginManifest({
      ...valid,
      conflicts: ['feature.example'],
    })).toThrow(expect.objectContaining<Partial<PluginManifestError>>({
      code: 'plugin_manifest_invalid',
      field: 'conflicts.0',
    }))
  })

  it('rejects empty or duplicate activation events', () => {
    expect(() => parsePylonPluginManifest({
      ...valid,
      activation: { events: ['kernel.ready', 'kernel.ready'] },
    })).toThrow(expect.objectContaining<Partial<PluginManifestError>>({
      code: 'plugin_manifest_invalid',
      field: 'activation.events',
    }))
  })
})

describe('api=1.2 package manifest (capabilities)', () => {
  const v12 = { ...valid, api: '1.2' as const }

  it('accepts a legal capabilities declaration', () => {
    const manifest = parsePylonPluginManifest({ ...v12, capabilities: ['plugin.management'] })
    expect(manifest.capabilities).toEqual(['plugin.management'])
  })

  it('accepts 1.2 without capabilities (field is optional)', () => {
    expect(parsePylonPluginManifest(v12)).toEqual(v12)
  })

  it('rejects an unknown capability (fail-closed vocabulary)', () => {
    expect(() => parsePylonPluginManifest({ ...v12, capabilities: ['plugin.filesystem'] }))
      .toThrow(expect.objectContaining<Partial<PluginManifestError>>({
        code: 'plugin_manifest_invalid',
        field: 'capabilities.0',
      }))
  })

  it('rejects duplicate capabilities', () => {
    expect(() => parsePylonPluginManifest({
      ...v12,
      capabilities: ['plugin.management', 'plugin.management'],
    })).toThrow(expect.objectContaining<Partial<PluginManifestError>>({
      code: 'plugin_manifest_invalid',
      field: 'capabilities.1',
    }))
  })

  it('rejects non-string or empty capability entries', () => {
    expect(() => parsePylonPluginManifest({ ...v12, capabilities: ['  '] }))
      .toThrow(expect.objectContaining<Partial<PluginManifestError>>({
        code: 'plugin_manifest_invalid',
        field: 'capabilities',
      }))
    expect(() => parsePylonPluginManifest({ ...v12, capabilities: 'plugin.management' }))
      .toThrow(/capabilities/)
  })

  it('rejects capabilities on api=1.1 manifests (version-aware removed-field rule)', () => {
    expect(() => parsePylonPluginManifest({ ...valid, api: '1.1', capabilities: ['plugin.management'] }))
      .toThrow(/capabilities.*API 1\.0/)
  })

  it('keeps the vocabulary closed and exported', () => {
    expect(PYLON_PLUGIN_CAPABILITIES).toEqual(['plugin.management'])
  })

  it('accepts api=1.3 and still rejects unknown higher versions', () => {
    expect(parsePylonPluginManifest({ ...valid, api: '1.3' }).api).toBe('1.3')
    expect(() => parsePylonPluginManifest({ ...valid, api: '1.4' })).toThrow(/仅支持/)
  })

  // 结构性看守（逐版本验收断言只覆盖到「有写一条用例」的版本）：allowlist 必须两端都在、
  // 无重复、且**每个历史 minor 都还在**——`PYLON_PLUGIN_API_SUPPORTED` 末尾写的是
  // LATEST，升版时最容易把上一个 latest 顶掉（2.3→2.4 就踩过一次）。
  it('allowlist 结构不变量：含最早/最新版、无重复、历史 minor 不丢', () => {
    expect(PYLON_PLUGIN_API_SUPPORTED).toContain(PYLON_PLUGIN_API_MIN)
    expect(PYLON_PLUGIN_API_SUPPORTED).toContain(PYLON_PLUGIN_API_LATEST)
    expect(new Set(PYLON_PLUGIN_API_SUPPORTED).size).toBe(PYLON_PLUGIN_API_SUPPORTED.length)
    for (const version of ['1.0', '1.1', '1.2', '1.3', '2.0', '2.1', '2.2', '2.3']) {
      expect(PYLON_PLUGIN_API_SUPPORTED).toContain(version)
    }
    for (const version of PYLON_PLUGIN_API_SUPPORTED) {
      expect(parsePylonPluginManifest({ ...valid, api: version }).api).toBe(version)
    }
  })

  it('accepts api=2.0（左栏贡献改按 region 注册的破坏性主轴）且仍拒绝未知更高版本', () => {
    expect(parsePylonPluginManifest({ ...valid, api: '2.0' }).api).toBe('2.0')
    expect(() => parsePylonPluginManifest({ ...valid, api: '2.5' })).toThrow(/仅支持/)
    // 1.x 清单继续合法：旧版本插件在新宿主继续激活（allowlist 只增不减）。
    expect(parsePylonPluginManifest({ ...valid, api: '1.0' }).api).toBe('1.0')
    // 破坏性主轴不改变 1.2 起合法的字段形状：2.0 清单同样可声明 capabilities。
    expect(parsePylonPluginManifest({ ...valid, api: '2.0', capabilities: ['plugin.management'] }).capabilities)
      .toEqual(['plugin.management'])
  })

  it('accepts api=2.1（标题栏设置菜单项贡献，纯加法）', () => {
    expect(parsePylonPluginManifest({ ...valid, api: '2.1' }).api).toBe('2.1')
    // 2.1 没有新 manifest 字段：2.0 清单形状照旧，capabilities 谓词照旧成立。
    expect(parsePylonPluginManifest({ ...valid, api: '2.0', capabilities: ['plugin.management'] }).capabilities)
      .toEqual(['plugin.management'])
  })

  it('accepts api=2.2（右栏面板种类改为亲和，纯放宽）', () => {
    expect(parsePylonPluginManifest({ ...valid, api: '2.2' }).api).toBe('2.2')
  })

  it('accepts api=2.3（会话置顶，纯加法）', () => {
    expect(parsePylonPluginManifest({ ...valid, api: '2.3' }).api).toBe('2.3')
  })

  it('accepts api=2.4（命令描述符新增检索词 keywords，纯加法）且仍拒绝未知更高版本', () => {
    expect(parsePylonPluginManifest({ ...valid, api: '2.4' }).api).toBe('2.4')
    // allowlist 只增不减：升到 2.4 后 2.3 清单必须继续合法。
    expect(parsePylonPluginManifest({ ...valid, api: '2.3' }).api).toBe('2.3')
    expect(() => parsePylonPluginManifest({ ...valid, api: '2.5' })).toThrow(/仅支持/)
  })

  it('accepts and validates dangerous hook declarations', () => {
    expect(parsePylonPluginManifest({ ...v12, dangerousHooks: ['turn.started'] })).toMatchObject({
      dangerousHooks: ['turn.started'],
    })
    expect(() => parsePylonPluginManifest({ ...v12, dangerousHooks: ['unknown.hook'] }))
      .toThrow(/dangerousHooks\.0/)
    expect(() => parsePylonPluginManifest({ ...valid, dangerousHooks: ['turn.started'] }))
      .toThrow(/dangerousHooks.*API 1\.0/)
  })
})

describe('api=1.3 package manifest (ADR-0001 vocabulary contract)', () => {
  const v13 = { ...valid, api: '1.3' as const }

  it('accepts api=1.3 manifests', () => {
    expect(parsePylonPluginManifest(v13)).toEqual(v13)
  })

  it('keeps capabilities/dangerousHooks legal for 1.2 manifests after the host bumped to 1.3 (>= predicate)', () => {
    expect(() => parsePylonPluginManifest({
      ...valid, api: '1.2', capabilities: ['plugin.management'], dangerousHooks: ['permission.request'],
    })).not.toThrow()
  })

  it('validates dangerousHooks against the API 1.3 vocabulary (permission.request in, retired anchors out)', () => {
    expect(parsePylonPluginManifest({ ...v13, dangerousHooks: ['permission.request'] })).toMatchObject({
      dangerousHooks: ['permission.request'],
    })
    expect(() => parsePylonPluginManifest({ ...v13, dangerousHooks: ['agent.chunk'] }))
      .toThrow(/dangerousHooks\.0/)
    expect(() => parsePylonPluginManifest({ ...v13, dangerousHooks: ['message.agent.committed'] }))
      .toThrow(/dangerousHooks\.0/)
  })
})
