import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  createPluginProcessClient,
  type PluginProcessClient,
} from '../../infrastructure/plugins/pluginProcessClient.ts'

let client: PluginProcessClient = createPluginProcessClient({
  transport: {
    invoke: (command, args) => invoke(command, args as Record<string, unknown> | undefined),
  },
  events: {
    listen: (event, listener) => listen(event, listener),
  },
})

export function getPluginProcessClient(): PluginProcessClient {
  return client
}

/** Test seam; returns a restoration function to prevent cross-test leakage. */
export function setPluginProcessClientForTests(next: PluginProcessClient): () => void {
  const previous = client
  client = next
  return () => {
    client = previous
  }
}
