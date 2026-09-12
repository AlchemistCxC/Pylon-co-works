import { ReactiveRegistryStore } from '../registry/reactiveRegistry.ts'
import type { TitlebarContribution } from './titlebarTypes.ts'

/** Reactive registry for application-shell titlebar contributions. */
export class TitlebarRegistry extends ReactiveRegistryStore<TitlebarContribution> {}
