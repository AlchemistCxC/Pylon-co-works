/** Composition-root seam used by Kernel bootstrap to mount the active application. */
export interface ApplicationMountPort {
  mount(applicationId: string): void
  unmount(): void
}
