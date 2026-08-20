export interface SolidWorkbenchSmokeInput {
  label: string
  value: number
}

export interface SolidWorkbenchSmokeLifecycle {
  update(input: SolidWorkbenchSmokeInput): void
  destroy(): void
}
