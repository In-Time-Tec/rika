import { describe, expect, test } from "bun:test"
import { ThreadMemoryIndexer } from "@rika/agent"
import { Ids } from "@rika/schema"
import { Effect, Layer } from "effect"
import { Memory, Output } from "../src/index"

const workspaceId = Ids.WorkspaceId.make("/workspace/rika")

describe("CLI memory commands", () => {
  test("prints memory status as JSON", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    const exitCode = await Effect.runPromise(
      Memory.executeCommand({ type: "memory", action: "status" }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Output.memoryLayer(output),
            ThreadMemoryIndexer.fakeLayer({
              status: () =>
                Effect.succeed({
                  chunk_count: 2,
                  embeddings: { available: false, reason: "missing RIKA_EMBEDDINGS_API_KEY" },
                }),
            }),
          ),
        ),
      ),
    )

    expect(exitCode).toBe(0)
    expect(JSON.parse(output.stdout[0] ?? "")).toEqual({
      chunk_count: 2,
      embeddings: { available: false, reason: "missing RIKA_EMBEDDINGS_API_KEY" },
    })
  })

  test("prints backfill progress as JSON", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    const exitCode = await Effect.runPromise(
      Memory.executeCommand({ type: "memory", action: "index", workspace_root: "/workspace/rika" }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Output.memoryLayer(output),
            ThreadMemoryIndexer.fakeLayer({
              backfill: (input) =>
                Effect.succeed({
                  ...(input.workspace_id === undefined ? {} : { workspace_id: input.workspace_id }),
                  indexed: 1,
                  skipped: 2,
                  failed: 0,
                }),
            }),
          ),
        ),
      ),
    )

    expect(exitCode).toBe(0)
    expect(JSON.parse(output.stdout[0] ?? "")).toEqual({
      workspace_id: workspaceId,
      indexed: 1,
      skipped: 2,
      failed: 0,
    })
  })
})
