import { describe, expect, it, vi } from 'vitest'
import { createPluginIdentity } from '../../plugin-runtime/pluginIdentity'
import '../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import { BUILTIN_WORKSPACE_TYPES } from '../../plugins/core/sheet/builtinWorkspacePlugins'
import type { WorkspaceTypeDefinition } from '../workspaceTypes'
import {
  getSheetLaunchOption,
  getSheetLaunchOptions,
  getSheetRegistryEntry,
  resolveSheetSingletonKey,
} from '../sheetRegistry'
import {
  getWorkspaceRegistrySnapshot,
  registerWorkspace,
  resolveWorkspace,
  subscribeWorkspaceRegistry,
} from '../workspaceRegistry'
import { createRuntimeServices } from '../../plugin-runtime/runtimeServices.ts'
import { WorkspaceRegistryStore } from '../workspaceRegistry.ts'

describe('Workspace Registry（阶段 6 首个切片）', () => {
  // P77：gateway 类型由第 7 包 builtin.pylon-gateway 贡献（core BUILTIN_WORKSPACE_TYPES
  // 已摘除），productPluginTestBootstrap 全量装载后注册表 = core 种子 + 包贡献的 gateway。
  const SEEDED_KINDS = [...BUILTIN_WORKSPACE_TYPES.map(item => item.kind), 'gateway']

  it('9 个内置 workspace 全量种子，描述符字段完整', () => {
    const snapshot = getWorkspaceRegistrySnapshot()

    // core 列表不再含 gateway（包贡献唯一来源；双注册会被 registerType 抛错暴露）
    expect(BUILTIN_WORKSPACE_TYPES.map(item => item.kind)).not.toContain('gateway')
    expect(snapshot.workspaces).toHaveLength(SEEDED_KINDS.length)
    expect(snapshot.workspaces.map(item => item.kind).sort()).toEqual([...SEEDED_KINDS].sort())

    for (const workspace of snapshot.workspaces) {
      expect(workspace.kind).toBeTruthy()
      expect(workspace.label).toBeTruthy()
      expect(workspace.component).toBeDefined()
      expect(typeof workspace.createInitialState).toBe('function')
      expect(typeof workspace.serialize).toBe('function')
      expect(typeof workspace.deserialize).toBe('function')
      expect(typeof workspace.singleton).toBe('boolean')
      expect(['workspace', 'sheet', 'none']).toContain(workspace.sidebarMode)
    }
  })

  it('launchOptions 只包含声明 launch 的 workspace，且 getSheetLaunchOption 可用', () => {
    const options = getSheetLaunchOptions()

    // core launch 项 + 包贡献的 gateway launch 项
    expect(options).toHaveLength(BUILTIN_WORKSPACE_TYPES.filter(item => item.launch).length + 1)
    for (const option of options) {
      expect(option.title).toBeTruthy()
      expect(option.description).toBeTruthy()
      expect(typeof option.launchable).toBe('boolean')
      expect(option.icon).toBeTruthy()
      expect(option.category).toBeTruthy()
      expect(option.categoryLabel).toBeTruthy()
      expect(Number.isFinite(option.order)).toBe(true)
    }
    expect(getSheetLaunchOption('search')?.title).toBe('Search')
    expect(getSheetLaunchOption('overview')?.icon).toBe('layout-dashboard')
    expect(getSheetLaunchOption('agent')).toBeUndefined()
  })

  it('sheetRegistry 门面与 registry 同源，singleton key 解析正确', () => {
    expect(getSheetRegistryEntry('file')?.label).toBe('File')
    expect(getSheetRegistryEntry('ghost')).toBeUndefined()

    expect(resolveSheetSingletonKey({ kind: 'agent', agentId: 'a1' })).toBe('agent:a1')
    expect(resolveSheetSingletonKey({ kind: 'agent', agentId: undefined })).toBeUndefined()
    expect(resolveSheetSingletonKey({ kind: 'file', singletonKey: 'file:src/a.ts' })).toBe('file:src/a.ts')
    expect(resolveSheetSingletonKey({ kind: 'prism' })).toBe('prism')
  })

  it('register/unregister 驱动 revision 并保持快照稳定', () => {
    const before = getWorkspaceRegistrySnapshot()
    const revisions: number[] = []
    const unsubscribe = subscribeWorkspaceRegistry(() => revisions.push(getWorkspaceRegistrySnapshot().revision))

    const descriptor: WorkspaceTypeDefinition = {
      kind: 'test-workspace',
      label: 'Test',
      singleton: true,
      getSingletonKey: () => 'test',
      sidebarMode: 'none',
      launch: { kind: 'test-workspace', title: 'Test', description: '测试 workspace', launchable: true, icon: 'custom', category: 'test', categoryLabel: '测试', categoryOrder: 1, order: 2, keywords: ['fixture'] },
      component: () => null,
      createInitialState: () => undefined,
      serialize: state => state,
      deserialize: raw => raw,
    }
    const owner = createPluginIdentity('test.workspace', 'registry-test')
    const registration = registerWorkspace(owner, descriptor)

    const afterRegister = getWorkspaceRegistrySnapshot()
    expect(afterRegister.revision).toBeGreaterThan(before.revision)
    expect(resolveWorkspace('test-workspace')?.label).toBe('Test')
    expect(getSheetRegistryEntry('test-workspace')?.component).toBe(descriptor.component)
    expect(getSheetLaunchOption('test-workspace')?.title).toBe('Test')
    expect(getSheetLaunchOption('test-workspace')?.keywords).toEqual(['fixture'])
    expect(Object.isFrozen(getSheetLaunchOption('test-workspace')?.keywords)).toBe(true)

    expect(afterRegister.entries.find(entry => entry.descriptor.kind === 'test-workspace')).toMatchObject({
      ownerPluginId: owner.pluginId,
      ownerRuntimeInstanceId: owner.key,
    })

    registration.dispose()
    registration.dispose() // 幂等
    expect(resolveWorkspace('test-workspace')).toBeUndefined()
    expect(getSheetLaunchOption('test-workspace')).toBeUndefined()

    expect(revisions.length).toBe(2)
    unsubscribe()
  })

  it('重复注册同 kind 报错', () => {
    const owner = createPluginIdentity('test.workspace', 'duplicate-test')
    expect(() => registerWorkspace(owner, { ...BUILTIN_WORKSPACE_TYPES[0] })).toThrow('workspace 已注册')
  })

  it('RuntimeServices 可注入唯一 registry，并支持 dispose 清理', () => {
    const registry = new WorkspaceRegistryStore()
    const services = createRuntimeServices({ workspaceRegistry: registry })
    expect(services.workspaceRegistry).toBe(registry)
    const listener = vi.fn()
    const unsubscribe = registry.subscribe(listener)
    registry.dispose()
    expect(registry.getSnapshot().entries).toEqual([])
    unsubscribe()
    expect(listener).not.toHaveBeenCalled()
  })
})
