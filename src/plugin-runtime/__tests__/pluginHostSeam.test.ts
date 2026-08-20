import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Plugin Host dependency boundary', () => {
  it('keeps runtime and activation modules independent from Kernel and global runtime services', () => {
    for (const relative of [
      '../pluginRuntime.ts',
      '../pluginInstance.ts',
      '../pluginActivationContext.ts',
    ]) {
      const source = readFileSync(new URL(relative, import.meta.url) as unknown as string, 'utf8')
      expect(source, relative).not.toMatch(/from ['"]\.\.\/kernel\//)
      expect(source, relative).not.toMatch(/from ['"].*runtimeServices/)
    }
  })
})
