import { describe, expect, it } from 'vitest'
import { applicationRuntime, requestApplicationSoftRemount } from '../applicationRuntimeServices.ts'

describe('Application soft-remount service', () => {
  it('crosses a real unmount/mount revision while preserving the application identity', async () => {
    const registration = applicationRuntime.registerBuiltin({ id: 'phase9.test-app', component: () => null })
    applicationRuntime.mount('phase9.test-app')
    const before = applicationRuntime.getSnapshot()
    await requestApplicationSoftRemount()
    const after = applicationRuntime.getSnapshot()
    expect(after.activeApplicationId).toBe('phase9.test-app')
    expect(after.revision).toBe(before.revision + 2)
    registration.dispose()
  })
})
