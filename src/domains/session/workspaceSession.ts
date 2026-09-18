/** Store-independent Session view used by plugin runtime contracts. */
export interface WorkspaceSession {
  id: string
  agentId: string
  periId?: string
  name: string
  source: string
  profileId: string
  createdAt: number
  lastActiveAt: number
  lastReplyAt?: number
  /** 置顶（在工作区内排最前）。左栏渲染与插件读同一份会话视图，因此这里必须有。 */
  pinned?: boolean
  platform: string
  workdir: string
  workspaceId?: string
  sessionPrompt: string
  skills: string[]
  hooks: string[]
  commandSetPlugins?: string[]
  autoName: string
}
