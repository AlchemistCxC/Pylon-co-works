export function normalizeSpinnerVerbs(value: string, fallback: readonly string[]): string[] {
  const verbs = Array.from(new Set(value.split(/\r?\n/).map(item => item.trim()).filter(Boolean)))
  return verbs.length > 0 ? verbs : [...fallback]
}
