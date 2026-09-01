import { describe, expect, it } from 'vitest'
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

type PublicApiTypes = [
  PluginApplicationApi,
  PluginWorkspaceApi,
  PluginServiceApi,
  PluginSidebarApi,
  PluginFileWorkbenchApi,
  PluginContextPanelApi,
  PluginFontApi,
  PluginSessionCreationApi,
  PluginInterfaceModeApi,
  PluginTitlebarApi,
]

function readPublicApis(context: PluginActivationContext): PublicApiTypes {
  return [
    context.application,
    context.workspace,
    context.services,
    context.sidebar,
    context.fileWorkbench,
    context.contextPanel,
    context.fonts,
    context.sessionCreation,
    context.interfaceModes,
    context.titlebar,
  ]
}

describe('SDK public exports', () => {
  it('keeps named context API types available from the SDK index', () => {
    expect(readPublicApis).toBeTypeOf('function')
  })

  it('exports the runtime-neutral storage error contract', () => {
    expect(new PluginStorageError('quota', 'over budget')).toBeInstanceOf(Error)
  })
})
