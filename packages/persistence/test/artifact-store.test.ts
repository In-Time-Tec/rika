import { describe, expect, test } from "bun:test"
import { Common, Ids } from "@rika/schema"
import { Effect, Layer, Option } from "effect"
import { ArtifactStore, Database, Migration } from "../src/index"

const databaseLayer = Database.memoryLayer
const artifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(databaseLayer))
const layer = Layer.mergeAll(databaseLayer, Migration.layer, artifactLayer)

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
      workspace_id: Ids.WorkspaceId.make("workspace_review_other"),
      created_at: Common.TimestampMillis.make(1235),
    }
    const workspaceArtifact = {
      ...artifact,
      id: Ids.ArtifactId.make("artifact_review_3"),
      workspace_id: Ids.WorkspaceId.make("workspace_review"),
      created_at: Common.TimestampMillis.make(1236),
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ArtifactStore.put(artifact)
        yield* ArtifactStore.put(otherThreadArtifact)
        yield* ArtifactStore.put(workspaceArtifact)
        const stored = yield* ArtifactStore.get(artifact.id)
        const listed = yield* ArtifactStore.list({ thread_id: artifact.thread_id, kind: "review" })
        const listedAll = yield* ArtifactStore.listAll({ kind: "review" })
        const listedByWorkspace = yield* ArtifactStore.listAll({
          workspace_id: Ids.WorkspaceId.make("workspace_review"),
          kind: "review",
        })
        return { stored, listed, listedAll, listedByWorkspace }
      }).pipe(Effect.provide(layer)),
    )

    expect(Option.getOrUndefined(result.stored)).toEqual(artifact)
    expect(result.listed).toEqual([workspaceArtifact, artifact])
    expect(result.listedAll).toEqual([workspaceArtifact, otherThreadArtifact, artifact])
    expect(result.listedByWorkspace).toEqual([workspaceArtifact])
  })
})
