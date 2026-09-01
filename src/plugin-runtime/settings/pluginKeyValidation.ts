export function validatePluginKey(key: string, label: string): void {
  if (!key || key !== key.trim() || key.includes('__proto__')) {
    throw new Error(`${label} key 非法：${key}`)
  }
}
