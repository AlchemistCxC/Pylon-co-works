import { ReactiveRegistryStore } from './reactiveRegistry.ts'

export class RegistryHub {
  private readonly registries = new Map<string, ReactiveRegistryStore<unknown>>()

  define<T>(id: string): ReactiveRegistryStore<T> {
    if (!id) throw new Error('Registry id 不能为空')
    if (this.registries.has(id)) throw new Error(`Registry 已定义：${id}`)
    const registry = new ReactiveRegistryStore<T>()
    this.registries.set(id, registry as ReactiveRegistryStore<unknown>)
    return registry
  }

  get<T>(id: string): ReactiveRegistryStore<T> {
    const registry = this.registries.get(id)
    if (!registry) throw new Error(`Registry 未定义：${id}`)
    return registry as ReactiveRegistryStore<T>
  }

  ids(): string[] {
    return [...this.registries.keys()].sort()
  }
}
