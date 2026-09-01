/** Runtime-neutral public storage contract shared by host and SDK bundles. */
export const PLUGIN_STORAGE_BUDGET_BYTES = 1024 * 1024

export class PluginStorageError extends Error {
  readonly code = 'plugin_storage_error'

  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message)
    this.name = 'PluginStorageError'
  }
}
