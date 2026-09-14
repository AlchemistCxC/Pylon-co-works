import { describe, expect, expectTypeOf, it } from 'vitest'
import * as sdk from '../index.ts'
import { PluginStorageError } from '../index.ts'
import type {
  PluginActivationContext,
  PluginApplicationApi,
  PluginContextPanelApi,
  PluginFileWorkbenchApi,
  PluginFontApi,
  PluginInterfaceModeApi,
  PluginServiceApi,
  PluginSessionCreationApi,
  PluginSidebarApi,
  PluginTitlebarApi,
  PluginWorkspaceApi,
} from '../index.ts'

describe('SDK public exports', () => {
  it('keeps named context API types reachable from the SDK index (compile-time assignability)', () => {
    // 激活上下文各面均可赋给公开 Plugin*Api 契约（编译期断言，expectTypeOf 零运行时代价）
    expectTypeOf<PluginActivationContext['application']>().toExtend<PluginApplicationApi>()
    expectTypeOf<PluginActivationContext['workspace']>().toExtend<PluginWorkspaceApi>()
    expectTypeOf<PluginActivationContext['services']>().toExtend<PluginServiceApi>()
    expectTypeOf<PluginActivationContext['sidebar']>().toExtend<PluginSidebarApi>()
    expectTypeOf<PluginActivationContext['fileWorkbench']>().toExtend<PluginFileWorkbenchApi>()
    expectTypeOf<PluginActivationContext['contextPanel']>().toExtend<PluginContextPanelApi>()
    expectTypeOf<PluginActivationContext['fonts']>().toExtend<PluginFontApi>()
    expectTypeOf<PluginActivationContext['sessionCreation']>().toExtend<PluginSessionCreationApi>()
    expectTypeOf<PluginActivationContext['interfaceModes']>().toExtend<PluginInterfaceModeApi>()
    expectTypeOf<PluginActivationContext['titlebar']>().toExtend<PluginTitlebarApi>()
  })

  it('exposes the runtime-value export surface of the SDK barrel', () => {
    expect(typeof sdk.definePlugin).toBe('function')
    expect(typeof sdk.validatePluginManifest).toBe('function')
    expect(typeof sdk.createPluginLogger).toBe('function')
    expect(typeof sdk.createSettingsSurface).toBe('function')
    expect(sdk.PYLON_PLUGIN_CAPABILITIES.length).toBeGreaterThan(0)
    expect(sdk.PLUGIN_STORAGE_BUDGET_BYTES).toBeGreaterThan(0)
  })

  it('exports the runtime-neutral storage error contract', () => {
    expect(new PluginStorageError('quota', 'over budget')).toBeInstanceOf(Error)
  })
})
