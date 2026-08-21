import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Layer, Ref } from "effect"
import { Machine, workspaceLayer, type State } from "../src/machine"

describe("checkout machine operations", () => {
  it.effect("executes filesystem and process work once beside the checkout and fences conflicting ids", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => import("node:fs/promises").then((fs) => fs.mkdtemp("/tmp/rika-machine-"))),
          (path) => Effect.promise(() => import("node:fs/promises").then((fs) => fs.rm(path, { recursive: true }))),
        )
        const receipts = yield* Ref.make(new Map<string, State>())
        const build = () =>
          Layer.build(
            workspaceLayer({
              workspace: root,
              read: (machineId) => Effect.map(Ref.get(receipts), (current) => current.get(machineId)),
              write: (machineId, state) => Ref.update(receipts, (current) => new Map(current).set(machineId, state)),
            }),
          ).pipe(Effect.map((context) => Context.get(context, Machine)))
        const machine = yield* build()
        const written = yield* machine.execute({
          machineId: "write-1",
          requestDigest: "write-digest",
          request: { _tag: "CodingTool", request: { _tag: "Write", path: "checkout.txt", content: "local" } },
        })
        const command = {
          _tag: "CodingTool" as const,
          request: { _tag: "Bash" as const, command: 'printf "once" >> process.txt' },
        }
        const first = yield* machine.execute({
          machineId: "process-1",
          requestDigest: "process-digest",
          request: command,
        })
        const duplicate = yield* machine.execute({
          machineId: "process-1",
          requestDigest: "process-digest",
          request: command,
        })
        const fenced = yield* machine.execute({
          machineId: "process-1",
          requestDigest: "different-digest",
          request: { _tag: "CodingTool", request: { _tag: "Bash", command: 'printf "twice" >> process.txt' } },
        })
        const restarted = yield* build()
        const replayed = yield* restarted.execute({
          machineId: "process-1",
          requestDigest: "process-digest",
          request: command,
        })
        const files = yield* Effect.promise(() =>
          Promise.all([Bun.file(`${root}/checkout.txt`).text(), Bun.file(`${root}/process.txt`).text()]),
        )

        expect(written._tag).toBe("Success")
        expect(first).toEqual(duplicate)
        expect(replayed).toEqual(first)
        expect(fenced).toEqual({ _tag: "Fenced", message: "machine call id conflicts with a different request" })
        expect(files).toEqual(["local", "once"])
      }),
    ),
  )

  it.effect("returns typed machine failures and marks a restarted running receipt unknown", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => import("node:fs/promises").then((fs) => fs.mkdtemp("/tmp/rika-machine-failure-"))),
          (path) => Effect.promise(() => import("node:fs/promises").then((fs) => fs.rm(path, { recursive: true }))),
        )
        const receipts = yield* Ref.make(
          new Map<string, State>([["crossed-1", { _tag: "Running", requestDigest: "crossed-digest" }]]),
        )
        const context = yield* Layer.build(
          workspaceLayer({
            workspace: root,
            read: (machineId) => Effect.map(Ref.get(receipts), (current) => current.get(machineId)),
            write: (machineId, state) => Ref.update(receipts, (current) => new Map(current).set(machineId, state)),
          }),
        )
        const machine = Context.get(context, Machine)
        const failure = yield* machine.execute({
          machineId: "read-1",
          requestDigest: "read-digest",
          request: { _tag: "CodingTool", request: { _tag: "Read", path: "missing.txt" } },
        })
        const unknown = yield* machine.execute({
          machineId: "crossed-1",
          requestDigest: "crossed-digest",
          request: { _tag: "CodingTool", request: { _tag: "Read", path: "missing.txt" } },
        })

        expect(failure._tag).toBe("Failure")
        if (failure._tag === "Failure") expect(failure.failure._tag).toBe("ToolError")
        expect(unknown).toEqual({ _tag: "Unknown", message: "machine call outcome is unknown after executor restart" })
      }),
    ),
  )
})
