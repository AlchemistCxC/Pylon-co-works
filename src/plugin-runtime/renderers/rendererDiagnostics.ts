import type { RendererDiagnostic } from './rendererSuiteTypes.ts'

export function createRendererDiagnostic(
  code: string,
  message: string,
  details: Omit<RendererDiagnostic, 'code' | 'message'> = {},
): RendererDiagnostic {
  return Object.freeze({ code, message, ...details })
}
