import { BunCrypto } from "@effect/platform-bun"
import { Context, Effect, Layer } from "effect"
import * as S3 from "generalist/durability/s3"
import type { RuntimeActorOptions } from "generalist/unstable/rivet"

export type RuntimeStorage = RuntimeActorOptions["storage"]
export type RuntimeStorageContext = Context.Context<Layer.Success<ReturnType<typeof runtimeStorageLayer>>>

export interface RuntimeStorageOptions {
  readonly bucket: string
  readonly region: string
  readonly endpoint?: string
  readonly forcePathStyle?: boolean
  readonly credentials?: S3.ConnectionOptions["credentials"]
  readonly capabilities?: S3.ConnectionOptions["capabilities"]
}

/**
 * Build one object-store/Crypto layer for the process and pass the resulting shared context to every actor. The
 * object store is the sole execution authority; Rivet only hosts the scoped Runtime.
 */
export const runtimeStorageLayer = (options: RuntimeStorageOptions): RuntimeStorage => {
  const connection: S3.ConnectionOptions = { bucket: options.bucket, region: options.region }
  if (options.endpoint !== undefined) Object.assign(connection, { endpoint: options.endpoint })
  if (options.forcePathStyle !== undefined) Object.assign(connection, { forcePathStyle: options.forcePathStyle })
  if (options.credentials !== undefined) Object.assign(connection, { credentials: options.credentials })
  if (options.capabilities !== undefined) Object.assign(connection, { capabilities: options.capabilities })
  return Layer.merge(S3.layer(connection).pipe(Layer.orDie), BunCrypto.layer)
}

/** Build the ObjectStore/Crypto clients once in the process scope. */
export const buildRuntimeStorage = (
  options: RuntimeStorageOptions,
): Effect.Effect<RuntimeStorageContext, never, never> => Effect.scoped(Layer.build(runtimeStorageLayer(options)))

/** Reuse a process-scoped storage context in every actor incarnation. */
export const runtimeStorageFromContext = (context: RuntimeStorageContext): RuntimeStorage =>
  Layer.succeedContext(context)
