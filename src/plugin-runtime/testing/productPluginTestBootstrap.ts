import { beforeAll } from 'vitest'
import { bootstrapBuiltins } from '../pluginCompositionRoot.ts'

/** Explicit opt-in for tests that consume first-party product contributions. */
beforeAll(async () => {
  const result = await bootstrapBuiltins('normal')
  if (result.failures.length > 0) {
    throw new Error(`Product plugin test bootstrap failed: ${result.failures.map(item => `${item.pluginId}: ${item.message}`).join('; ')}`)
  }
})
