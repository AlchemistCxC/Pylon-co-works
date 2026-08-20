export interface ClientTransport {
  invoke(command: string, args?: unknown): Promise<unknown>
}
