import { Effect, Schema } from "effect"
import type { HostBindingRegistry } from "tenetkit/repl"
import { ArtifactStore, ArtifactUnavailable, Stored } from "./store"
import { nested, NestedOperationFailed, operation, type Requirements } from "../envelope"

export const name = "artifacts"

const Failure = Schema.Union([ArtifactUnavailable, NestedOperationFailed])

const PutInput = Schema.Struct({ value: Schema.Unknown, mediaType: Schema.optionalKey(Schema.String) })
/**
 * An identifier is the digest a put returned, and it names a file. Accepting any string would let a
 * cell name a path outside the directory artifacts live in, so the shape a put mints is the shape a
 * get will take.
 */
const GetInput = Schema.Struct({ id: Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}$/)) })
const Loaded = Schema.Struct({ value: Schema.Unknown })

export const operations: ReadonlyArray<HostBindingRegistry.AnyOperation<ArtifactStore | Requirements>> = [
  operation({
    name: "put",
    input: PutInput,
    output: Stored,
    failure: Failure,
    handle: (input) =>
      nested(
        { kind: "artifacts.put", payload: input, replayPolicy: "provider-idempotent" },
        Effect.flatMap(ArtifactStore, (store) =>
          store.put({ value: input.value, ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }) }),
        ),
      ),
  }),
  operation({
    name: "get",
    input: GetInput,
    output: Loaded,
    failure: Failure,
    handle: (input) =>
      Effect.map(
        Effect.flatMap(ArtifactStore, (store) => store.get(input.id)),
        (value) => ({ value }),
      ),
  }),
]

export const module: HostBindingRegistry.Module<ArtifactStore | Requirements> = { name, operations }
