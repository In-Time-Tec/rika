import * as ExecutionIdentifier from "@rika/product/execution-identifier"
import * as UsageRepository from "@rika/product/usage-repository"
import type { SourceUsage } from "@rika/product/usage-snapshot"
import { Effect, Result } from "effect"
import * as UsageProjection from "../../usage/usage-projection"
import * as UsageSnapshot from "../../usage/usage-snapshot"
import * as UsageCodec from "../../usage/usage-snapshot-codec"
import type * as IngestEvent from "./execution-ingest-event"
import type { Node } from "./execution-ingest-state"

interface Input {
  readonly backend: import("@rika/product/execution-service").Interface
  readonly usage: UsageRepository.Interface
  readonly root: IngestEvent.Root
  readonly nodes: ReadonlyMap<string, Node>
  readonly sourceId: string
  readonly source: SourceUsage
  readonly fromVersion: number
}

export const run = Effect.fn("ExecutionIngestUsageBackfill.run")(function* (input: Input) {
  const replayed = yield* Effect.result(
    Effect.forEach(
      [...input.nodes.values()],
      (node) =>
        input.backend
          .replay(
            node.executionId,
            undefined,
            node.parentKey === undefined ? undefined : ExecutionIdentifier.executionReference,
          )
          .pipe(
            Effect.map((result) =>
              result.events.map((event) => ({
                threadId: String(input.root.threadId),
                turnId: String(input.root.turnId),
                event,
              })),
            ),
          ),
      { concurrency: 1 },
    ),
  )
  if (replayed._tag === "Failure") return false
  const folded = UsageProjection.foldBatch(UsageSnapshot.empty, replayed.success.flat(), new Set(input.nodes.keys()))
  if (Result.isFailure(folded)) return false
  const totals = {
    ...UsageProjection.materialize(folded.success, String(input.root.turnId), String(input.root.threadId)),
    sourceComplete: true,
  }
  const replacement = yield* Effect.result(
    input.usage.replaceSource(
      input.sourceId,
      String(input.root.turnId),
      String(input.root.threadId),
      input.fromVersion,
      input.source.revision,
      UsageCodec.serialize(folded.success),
      totals,
    ),
  )
  return (
    replacement._tag === "Success" &&
    (replacement.success._tag === "Applied" || replacement.success.value?.sourceComplete === true)
  )
})
