import { ReactiveRegistryStore } from './reactiveRegistry.js';
export declare class RegistryHub {
    private readonly registries;
    define<T>(id: string): ReactiveRegistryStore<T>;
    get<T>(id: string): ReactiveRegistryStore<T>;
    ids(): string[];
}
