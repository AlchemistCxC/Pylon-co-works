/**
 * Compatibility export retained for downstream shells. Interaction rejection
 * notifications are now rendered by the application ErrorCenter; mounting
 * this component must never create a second top-level toast.
 */
export default function InteractionRejectionNotice() {
  return null
}
