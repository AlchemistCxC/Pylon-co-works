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
  platform: string
  workdir: string
  workspaceId?: string
  sessionPrompt: string
  skills: string[]
  hooks: string[]
  commandSetPlugins?: string[]
  autoName: string
}
