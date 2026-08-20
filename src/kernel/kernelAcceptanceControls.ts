export const KERNEL_ACCEPTANCE_STORAGE_KEY = 'pylon.kernel.acceptance'

export function shouldExposeKernelAcceptanceControls(
  isDev: boolean,
  storage: Pick<Storage, 'getItem'> | null,
): boolean {
  if (isDev) return true
  if (!storage) return false
  try {
    return storage.getItem(KERNEL_ACCEPTANCE_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}
