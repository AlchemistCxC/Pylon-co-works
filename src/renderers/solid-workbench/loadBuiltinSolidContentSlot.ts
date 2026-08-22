type BuiltinSolidContentSlotModule = {
  BuiltinSolidContentSlot: unknown
}

const modules = import.meta.glob<BuiltinSolidContentSlotModule>('./chat/BuiltinSolidContentSlot.solid.tsx')

/** Keep the React TypeScript project from compiling Solid JSX with React JSX types. */
export async function loadBuiltinSolidContentSlot(): Promise<unknown> {
  const load = modules['./chat/BuiltinSolidContentSlot.solid.tsx']
  if (!load) throw new Error('Built-in Solid content Slot 未进入 Vite module graph')
  const module = await load()
  if (!module.BuiltinSolidContentSlot) throw new Error('BuiltinSolidContentSlot 导出缺失')
  return module.BuiltinSolidContentSlot
}
