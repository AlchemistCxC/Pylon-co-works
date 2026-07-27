interface SendTransactionOptions {
  send: () => Promise<unknown>
  onSuccess: () => void
  onError: (error: unknown) => void
}

export async function runSendTransaction({ send, onSuccess, onError }: SendTransactionOptions): Promise<boolean> {
  try {
    await send()
    onSuccess()
    return true
  } catch (error) {
    onError(error)
    return false
  }
}
