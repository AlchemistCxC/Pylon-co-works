export type SessionCreationJson =
  | null
  | boolean
  | number
  | string
  | readonly SessionCreationJson[]
  | { readonly [key: string]: SessionCreationJson }

export interface SessionCreationProfileSnapshot {
  readonly id: string
  readonly name: string
  readonly persona: string
  readonly model: string
}

/** Immutable facts available while a new local Session row is assembled. */
export interface SessionCreationContext {
  readonly sessionId: string
  readonly source: string
  readonly title: string
  readonly agentId: string
  readonly profile: SessionCreationProfileSnapshot
  readonly platform: string
  readonly workdir: string
  readonly workspaceId?: string
  /** Workspace capabilities frozen for this session; only apply on new sessions. */
  readonly workspaceSkills?: readonly string[]
  readonly workspaceMcpServerIds?: readonly string[]
  readonly workspaceHookPluginIds?: readonly string[]
}

export type SessionCreationPayloadResolver = (
  context: SessionCreationContext,
) => SessionCreationJson | null | undefined

/**
 * The input kind and payload are deliberately open. Plugins define the kind,
 * then register a compiler for it; the host does not enumerate prompt/skill/MCP.
 */
export interface SessionCreationContribution {
  readonly id: string
  readonly kind: string
  readonly payload: SessionCreationJson | SessionCreationPayloadResolver
  readonly order?: number
  readonly failurePolicy?: 'optional' | 'required'
}

export interface ResolvedSessionCreationContribution {
  readonly id: string
  readonly kind: string
  readonly ownerPluginId: string
  readonly ownerRuntimeInstanceId: string
  readonly payload: SessionCreationJson
  readonly order: number
  readonly failurePolicy: 'optional' | 'required'
}

export interface SessionCreationArtifactDraft {
  /** Open, namespaced lifecycle phase. */
  readonly phase: string
  /** Open, namespaced artifact kind interpreted by a phase handler. */
  readonly kind: string
  readonly payload: SessionCreationJson
  readonly order?: number
}

export interface SessionCreationCompiler {
  readonly id: string
  readonly kind: string
  readonly order?: number
  compile(
    contribution: ResolvedSessionCreationContribution,
    context: SessionCreationContext,
  ): readonly SessionCreationArtifactDraft[]
}

export interface SessionCreationArtifactSnapshot {
  readonly id: string
  readonly phase: string
  readonly kind: string
  readonly ownerPluginId: string
  readonly ownerRuntimeInstanceId: string
  readonly sourceContributionId: string
  readonly order: number
  readonly failurePolicy: 'optional' | 'required'
  readonly payload: SessionCreationJson
}

export interface SessionCreationDiagnostic {
  readonly contributionId: string
  readonly ownerPluginId: string
  readonly message: string
}

export interface SessionCreationSnapshot {
  readonly version: 1
  readonly createdAt: number
  readonly registryRevision: number
  readonly artifacts: readonly SessionCreationArtifactSnapshot[]
  readonly diagnostics: readonly SessionCreationDiagnostic[]
}

export interface SessionCreationRuntimeSession {
  readonly id: string
  readonly agentId: string
  readonly source: string
  readonly profileId: string
  readonly workdir: string
  readonly workspaceId?: string
  /** Workspace capabilities frozen for this session; only apply on new sessions. */
  readonly workspaceSkills?: readonly string[]
  readonly workspaceMcpServerIds?: readonly string[]
  readonly workspaceHookPluginIds?: readonly string[]
}

export interface SessionCreationPhaseContext {
  readonly session: SessionCreationRuntimeSession
  readonly signal: AbortSignal
}

export interface SessionCreationPhaseEffect {
  readonly kind: string
  readonly payload: SessionCreationJson
}

export interface SessionCreationArtifactHandler {
  readonly id: string
  readonly phase: string
  readonly kind: string
  readonly order?: number
  run(
    artifact: SessionCreationArtifactSnapshot,
    context: SessionCreationPhaseContext,
  ): void | readonly SessionCreationPhaseEffect[] | Promise<void | readonly SessionCreationPhaseEffect[]>
}

export interface SessionCreationPhaseResult {
  readonly effects: readonly SessionCreationPhaseEffect[]
  readonly diagnostics: readonly SessionCreationDiagnostic[]
}
