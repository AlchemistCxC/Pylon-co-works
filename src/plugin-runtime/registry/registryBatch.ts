let depth = 0
const pending = new Set<() => void>()

export function notifyRegistryListener(listener: () => void): void {
  if (depth > 0) pending.add(listener)
  else listener()
}

/** Defers external-store notifications until all participating registries hold the new snapshot. */
export function runRegistryBatch<T>(operation: () => T): T {
  depth += 1
  try {
    return operation()
  } finally {
    depth -= 1
    if (depth === 0) {
      const listeners = [...pending]
      pending.clear()
      for (const listener of listeners) listener()
    }
  }
}
