import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, Ref } from "effect"
import { Machine, workspaceLayer, type State } from "../../../src/host/machinery/machine"
import { provideLayer } from "../layer"

describe("checkout machine operations", () => {
  it.effect("executes filesystem and process work once beside the checkout and fences conflicting ids", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-machine-" })
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
          request: { _tag: "NativeTool", request: { _tag: "Bash", command: "printf local > checkout.txt" } },
        })
        const command = {
          _tag: "NativeTool" as const,
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
          request: { _tag: "NativeTool", request: { _tag: "Bash", command: 'printf "twice" >> process.txt' } },
        })
        const restarted = yield* build()
        const replayed = yield* restarted.execute({
          machineId: "process-1",
          requestDigest: "process-digest",
          request: command,
        })
        const files = yield* Effect.all([
          fileSystem.readFileString(`${root}/checkout.txt`),
          fileSystem.readFileString(`${root}/process.txt`),
        ])

        expect(written._tag).toBe("Success")
        expect(first).toEqual(duplicate)
        expect(replayed).toEqual(first)
        expect(fenced).toEqual({ _tag: "Fenced", message: "machine call id conflicts with a different request" })
        expect(files).toEqual(["local", "once"])
      }).pipe(provideLayer(BunServices.layer)),
    ),
  )

  it.effect("returns typed machine failures and marks a restarted running receipt unknown", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-machine-failure-" })
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
          request: { _tag: "NativeTool", request: { _tag: "Read", path: "missing.txt" } },
        })
        const unknown = yield* machine.execute({
          machineId: "crossed-1",
          requestDigest: "crossed-digest",
          request: { _tag: "NativeTool", request: { _tag: "Read", path: "missing.txt" } },
        })
        const missingCancellation = yield* machine.cancel({
          machineId: "missing-1",
          requestDigest: "missing-digest",
        })
        const admittedCancellation = yield* machine.cancel({
          machineId: "admitted-1",
          requestDigest: "admitted-digest",
          admitted: true,
        })
        const cancelledReplay = yield* machine.execute({
          machineId: "admitted-1",
          requestDigest: "admitted-digest",
          request: { _tag: "NativeTool", request: { _tag: "Bash", command: "printf forbidden > forbidden.txt" } },
        })

        expect(failure._tag).toBe("Failure")
        if (failure._tag === "Failure") expect(failure.failure._tag).toBe("ToolError")
        expect(unknown).toEqual({ _tag: "Unknown", message: "machine call outcome is unknown after executor restart" })
        expect(missingCancellation).toEqual({
          _tag: "Unknown",
          message: "machine call was not retained before cancellation",
        })
        expect(admittedCancellation).toEqual({ _tag: "Cancelled" })
        expect(cancelledReplay).toEqual(admittedCancellation)
        expect(yield* fileSystem.exists(`${root}/forbidden.txt`)).toBe(false)
      }).pipe(provideLayer(BunServices.layer)),
    ),
  )
})
