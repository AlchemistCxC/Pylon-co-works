export interface ChatSourceRefCollections {
  messagesBySource: Record<string, unknown>
  generationStart: Record<string, unknown>
  generationFrames: Record<string, unknown>
  loadGeneration: Record<string, unknown>
  replayingSources: Record<string, unknown>
  replayToolIds: Record<string, unknown>
  cancelState: Record<string, unknown>
}

export function clearChatSourceRefs(refs: ChatSourceRefCollections, source: string): void {
  if (!source) return
  delete refs.messagesBySource[source]
  delete refs.generationStart[source]
  delete refs.generationFrames[source]
  delete refs.loadGeneration[source]
  delete refs.replayingSources[source]
  delete refs.replayToolIds[source]
  delete refs.cancelState[source]
}
