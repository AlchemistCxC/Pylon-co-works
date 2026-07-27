interface CloseSessionTransactionOptions {
  close: () => Promise<unknown>
  onSuccess: () => void
  onError: (error: unknown) => void
}

export async function runCloseSessionTransaction({
  close,
  onSuccess,
  onError,
}: CloseSessionTransactionOptions): Promise<boolean> {
  try {
    await close()
    onSuccess()
    return true
  } catch (error) {
    onError(error)
    return false
  }
}
