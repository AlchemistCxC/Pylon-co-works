/**
 * CWD-03：Workspace 实体 store（方案 C 前端权威缓存）。
 *
 * 权威源 = 后端注册表（workspace_* 命令，Tauri 模式）；浏览器/离线模式读写
 * localStorage 镜像（pylon-workspaces envelope）。hydrate 在启动 bootstrap 调用，
 * 与 identityStore.hydrateSessions 同序（workspace 先于会话绑定解析）。
 */
import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { IS_TAURI } from './infrastructure/tauri/env'
import { useIdentityStore } from './identityStore'
import {
  isAbsolutePath,
  newLocalWorkspaceId,
  normalizeWorkspaceShape,
  parseWorkspaces,
  serializeWorkspaces,
  WORKSPACE_STORAGE_KEY,
  type Workspace,
} from './workspaceEntities'

const readMirror = (): Workspace[] => {
  try {
    return parseWorkspaces(localStorage.getItem(WORKSPACE_STORAGE_KEY))
  } catch {
    return []
  }
}

const writeMirror = (workspaces: Workspace[]) => {
  try {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, serializeWorkspaces(workspaces))
  } catch {
    // 镜像写盘失败不抛：后端仍为权威源，下次 hydrate 自愈
  }
}

interface WorkspaceEntityStore {
  workspaces: Workspace[]
  hydrated: boolean
  hydrate: () => Promise<void>
  byId: (id: string) => Workspace | undefined
  createWorkspace: (name: string, rootPath: string) => Promise<Workspace>
  updateWorkspace: (id: string, patch: { name?: string; rootPath?: string; skills?: string[]; mcpServerIds?: string[]; hookPluginIds?: string[] }) => Promise<Workspace>
  deleteWorkspace: (id: string) => Promise<void>
}

export const useWorkspaceEntityStore = create<WorkspaceEntityStore>((set, get) => ({
  workspaces: [],
  hydrated: false,

  byId: id => get().workspaces.find(workspace => workspace.id === id),

  hydrate: async () => {
    if (get().hydrated) return
    if (IS_TAURI) {
      try {
        let raw = await invoke('workspace_list')
        let workspaces = Array.isArray(raw)
          ? raw.map(normalizeWorkspaceShape).filter((w): w is Workspace => w !== null)
          : []
        // 旧版本只有 localStorage 镜像。新后端首次为空时做一次保 ID 导入，
        // 不能调用 create（会换 id，导致 Session.workspaceId 绑定断裂）。
        if (workspaces.length === 0) {
          const mirror = readMirror()
          if (mirror.length > 0) {
            raw = await invoke('workspace_restore', { workspaces: mirror })
            workspaces = Array.isArray(raw)
              ? raw.map(normalizeWorkspaceShape).filter((w): w is Workspace => w !== null)
              : mirror
          }
        }
        writeMirror(workspaces)
        set({ workspaces, hydrated: true })
        return
      } catch {
        // 后端不可用：回退镜像
      }
    }
    set({ workspaces: readMirror(), hydrated: true })
  },

  createWorkspace: async (name, rootPath) => {
    if (!isAbsolutePath(rootPath)) {
      throw new Error('工作目录必须是绝对路径')
    }
    let created: Workspace
    if (IS_TAURI) {
      const agentId = useIdentityStore.getState().activeAgent || ''
      const raw = await invoke('workspace_create', { agentId, name, rootPath })
      const normalized = normalizeWorkspaceShape(raw)
      if (!normalized) throw new Error('workspace_create 返回无效形状')
      created = normalized
    } else {
      created = {
        id: newLocalWorkspaceId(get().workspaces),
        agentId: '',
        name,
        rootPath,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        skills: [],
        mcpServerIds: [],
        hookPluginIds: [],
      }
    }
    const workspaces = [...get().workspaces, created]
    writeMirror(workspaces)
    set({ workspaces })
    return created
  },

  updateWorkspace: async (id, patch) => {
    if (patch.rootPath !== undefined && !isAbsolutePath(patch.rootPath)) {
      throw new Error('工作目录必须是绝对路径')
    }
    let updated: Workspace
    if (IS_TAURI) {
      const raw = await invoke('workspace_update', { workspaceId: id, ...patch })
      const normalized = normalizeWorkspaceShape(raw)
      if (!normalized) throw new Error('workspace_update 返回无效形状')
      updated = normalized
    } else {
      const current = get().byId(id)
      if (!current) throw new Error(`workspace not found: ${id}`)
      updated = {
        ...current,
        name: patch.name ?? current.name,
        rootPath: patch.rootPath ?? current.rootPath,
        skills: patch.skills ?? current.skills,
        mcpServerIds: patch.mcpServerIds ?? current.mcpServerIds,
        hookPluginIds: patch.hookPluginIds ?? current.hookPluginIds,
        lastActiveAt: Date.now(),
      }
    }
    const workspaces = get().workspaces.map(w => w.id === id ? updated : w)
    writeMirror(workspaces)
    set({ workspaces })
    return updated
  },

  deleteWorkspace: async id => {
    if (IS_TAURI) {
      await invoke('workspace_delete', { workspaceId: id })
    }
    const workspaces = get().workspaces.filter(w => w.id !== id)
    writeMirror(workspaces)
    set({ workspaces })
  },
}))
