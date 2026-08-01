import { Function, Schema } from "effect"

export type Loadable<T> =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly value: T }

const LoadableIdleSchema = Schema.TaggedStruct("Idle", {})
const LoadableLoadingSchema = Schema.TaggedStruct("Loading", {})

export const idle: Loadable<never> = { _tag: "Idle" }
export const loading: Loadable<never> = { _tag: "Loading" }
export const ready = <T>(value: T): Loadable<T> => ({ _tag: "Ready", value })
export const readyOr: {
  <T>(loadable: Loadable<T>, fallback: T): T
  <T>(fallback: T): (loadable: Loadable<T>) => T
} = Function.dual(
  2,
  <T>(loadable: Loadable<T>, fallback: T): T => (loadable._tag === "Ready" ? loadable.value : fallback),
)
export const isReady = <T>(loadable: Loadable<T>): loadable is { readonly _tag: "Ready"; readonly value: T } =>
  loadable._tag === "Ready"
export const isLoading = <T>(loadable: Loadable<T>): boolean => loadable._tag === "Loading"

export const loadableSchemas = {
  idle: LoadableIdleSchema,
  loading: LoadableLoadingSchema,
}
