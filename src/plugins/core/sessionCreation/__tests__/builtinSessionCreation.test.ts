import { beforeEach, describe, expect, it } from 'vitest'
import '../../../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import { useIdentityStore } from '../../../../identityStore.ts'
import { createPluginIdentity } from '../../../../plugin-runtime/pluginIdentity.ts'
import { getSessionCreationRegistry } from '../../../../plugin-runtime/runtimeServices.ts'
import { resetStores } from '../../../../test/resetStores.ts'
import { collectFirstMessagePromptPrelude } from '../builtinSessionCreation.ts'
import {
  ACP_NEW_SESSION_OPTIONS_EFFECT_KIND,
  runSessionPreflight,
  SESSION_PREFLIGHT_PHASE,
} from '../sessionPreflight.ts'

describe('builtin Session creation contributions', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    useIdentityStore.setState({
      profiles: [{ id: 'profile-a', name: 'A', persona: '创建时 Persona', model: 'm' }],
      activeProfileId: 'profile-a',
      activeAgent: 'peri',
      sessions: [],
      sessionsHydrated: true,
      sessionHydration: { kind: 'ready' },
    })
  })

  it('addSession 冻结 Profile 普通贡献，插件 preflight 可在 session/new 前提供 MCP', async () => {
    const registry = getSessionCreationRegistry()
    const owner = createPluginIdentity('plugin.browser-control', 'test-run')
    const compiler = registry.registerCompiler(owner, {
      id: 'plugin.browser-control/compiler',
      kind: 'plugin.browser-control/bootstrap',
      compile: contribution => [{
        phase: SESSION_PREFLIGHT_PHASE,
        kind: 'plugin.browser-control/prepare',
        payload: contribution.payload,
      }],
    })
    const contribution = registry.registerContribution(owner, {
      id: 'plugin.browser-control/default',
      kind: 'plugin.browser-control/bootstrap',
      failurePolicy: 'required',
      payload: { mcpServers: [{ name: 'browser', command: 'pylon-browser-mcp' }] },
    })
    const handler = registry.registerArtifactHandler(owner, {
      id: 'plugin.browser-control/prepare-handler',
      phase: SESSION_PREFLIGHT_PHASE,
      kind: 'plugin.browser-control/prepare',
      run: artifact => [{ kind: ACP_NEW_SESSION_OPTIONS_EFFECT_KIND, payload: artifact.payload }],
    })
    try {
      const sessionId = useIdentityStore.getState().addSession('插件会话')
      const created = useIdentityStore.getState().sessions.find(session => session.id === sessionId)
      expect(created).toBeDefined()
      expect(collectFirstMessagePromptPrelude(created?.creationSnapshot)).toBe('创建时 Persona')

      useIdentityStore.setState({ profiles: [{ id: 'profile-a', name: 'A', persona: '后来 Persona', model: 'm' }] })
      expect(collectFirstMessagePromptPrelude(created?.creationSnapshot)).toBe('创建时 Persona')

      const preflight = await runSessionPreflight(created!)
      expect(preflight.mcpServers).toEqual([{ name: 'browser', command: 'pylon-browser-mcp' }])
      expect(preflight.diagnostics).toEqual([])
    } finally {
      await handler.dispose()
      await contribution.dispose()
      await compiler.dispose()
    }
  })
})
