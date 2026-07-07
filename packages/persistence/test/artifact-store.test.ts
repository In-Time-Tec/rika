import { describe, expect, test } from "bun:test"
import { Common, Event, Ids } from "@rika/schema"
import { Effect, Layer, Option } from "effect"
import { ArtifactStore, Database, Migration, ThreadProjection } from "../src/index"

const databaseLayer = Database.memoryLayer
const artifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(databaseLayer))
const layer = Layer.mergeAll(databaseLayer, Migration.layer, ThreadProjection.layer, artifactLayer)

describe("ArtifactStore", () => {
  test("persists and lists review artifacts by thread", async () => {
    const artifact = {
      id: Ids.ArtifactId.make("artifact_review_1"),
      thread_id: Ids.ThreadId.make("thread_review_1"),
      kind: "review" as const,
      title: "Review run",
      content: { review_id: "review_1", findings: [{ path: "src/app.ts", severity: "high" }] },
      created_at: Common.TimestampMillis.make(1234),
      metadata: { command: "review" },
    }
    const otherThreadArtifact = {
      ...artifact,
      id: Ids.ArtifactId.make("artifact_review_2"),
      thread_id: Ids.ThreadId.make("thread_review_2"),
      created_at: Common.TimestampMillis.make(1235),
    }
    const workspaceArtifact = {
      ...artifact,
      id: Ids.ArtifactId.make("artifact_review_3"),
      created_at: Common.TimestampMillis.make(1236),
    }
    const workspaceId = Ids.WorkspaceId.make("workspace_review")
    const otherWorkspaceId = Ids.WorkspaceId.make("workspace_review_other")
    const storedArtifact = { ...artifact, workspace_id: workspaceId }
    const storedOtherThreadArtifact = { ...otherThreadArtifact, workspace_id: otherWorkspaceId }
    const storedWorkspaceArtifact = { ...workspaceArtifact, workspace_id: workspaceId }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ThreadProjection.apply(threadCreated(artifact.thread_id, workspaceId, 1))
        yield* ThreadProjection.apply(threadCreated(otherThreadArtifact.thread_id, otherWorkspaceId, 1))
        yield* ArtifactStore.put(artifact)
        yield* ArtifactStore.put(otherThreadArtifact)
        yield* ArtifactStore.put(workspaceArtifact)
        const stored = yield* ArtifactStore.get(artifact.id)
        const listed = yield* ArtifactStore.list({ thread_id: artifact.thread_id, kind: "review" })
        const listedAll = yield* ArtifactStore.listAll({ kind: "review" })
        const listedByWorkspace = yield* ArtifactStore.listAll({
          workspace_id: workspaceId,
          kind: "review",
        })
        return { stored, listed, listedAll, listedByWorkspace }
      }).pipe(Effect.provide(layer)),
    )

    expect(Option.getOrUndefined(result.stored)).toEqual(storedArtifact)
    expect(result.listed).toEqual([storedWorkspaceArtifact, storedArtifact])
    expect(result.listedAll).toEqual([storedWorkspaceArtifact, storedOtherThreadArtifact, storedArtifact])
    expect(result.listedByWorkspace).toEqual([storedWorkspaceArtifact, storedArtifact])
  })

  test("resolves omitted workspace ids for workspace scoped lists across stored artifact kinds", async () => {
    const workspaceId = Ids.WorkspaceId.make("workspace_artifact_kind")
    const threadId = Ids.ThreadId.make("thread_artifact_kind")
    const kinds = ["review", "verdict", "orb-final-diff", "other"] as const

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ThreadProjection.apply(threadCreated(threadId, workspaceId, 1))
        const stored = yield* Effect.forEach(kinds, (kind, index) =>
          ArtifactStore.put({
            id: Ids.ArtifactId.make(`artifact_kind_${kind}`),
            thread_id: threadId,
            kind,
            title: `Artifact ${kind}`,
            content: { kind },
            created_at: Common.TimestampMillis.make(2_000 + index),
          }),
        )
        const listed = yield* Effect.forEach(kinds, (kind) =>
          ArtifactStore.listAll({ workspace_id: workspaceId, kind }),
        )
        return { stored, listed }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.stored.map((artifact) => artifact.workspace_id)).toEqual(kinds.map(() => workspaceId))
    expect(result.listed.map((items) => items.map((artifact) => artifact.kind))).toEqual(kinds.map((kind) => [kind]))
  })
})

const threadCreated = (
  threadId: Ids.ThreadId,
  workspaceId: Ids.WorkspaceId,
  sequence: number,
): Event.ThreadCreated => ({
  id: Ids.EventId.make(`event_${threadId}_${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  type: "thread.created",
  created_at: Common.TimestampMillis.make(1_000 + sequence),
  data: { workspace_id: workspaceId },
})
