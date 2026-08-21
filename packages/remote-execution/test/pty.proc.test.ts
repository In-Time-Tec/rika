import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Exit, FileSystem, Layer, Scope } from "effect"
import { userInfo } from "node:os"
import { Manager, PtyError, driverLayer, layer as ptyLayer, repositoryLayer, type Connection } from "../src/pty"
import type { Fence } from "../src/protocol"

const fence: Fence = {
  target: "e2b",
  assignmentId: "assignment-proc",
  assignmentGeneration: 1,
  instanceId: `sandbox-${process.pid}`,
  executorId: `executor-${process.pid}:process-${process.pid}`,
  processIncarnation: `process-${process.pid}`,
}
const workspaceUser = userInfo().username

const waitForOutput = Effect.fn("test.waitForPtyOutput")(function* (
  pty: Manager["Service"],
  cursor: number,
  expected: string,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const connection = yield* pty.reconnect({ ptyId: "pty-proc", cursor })
    if (connection.transcript.some((chunk) => chunk.data.includes(expected))) return connection
    yield* Effect.sleep("20 millis")
  }
  return yield* PtyError.make({ kind: "driver", message: `PTY output did not contain ${expected}` })
})

describe("tmux PTY driver", () => {
  it.live(
    "keeps the shell process alive across detach, reattaches, resizes, and terminates explicitly",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const services = yield* Layer.build(BunServices.layer)
          const fileSystem = Context.get(services, FileSystem.FileSystem)
          const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-pty-workspace-" })
          const stateDirectory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-pty-state-" })
          const buildManager = Effect.fn("test.buildPtyManager")(function* (scope: Scope.Closeable) {
            const managerLayer = ptyLayer.pipe(
              Layer.provide(
                Layer.merge(
                  repositoryLayer({ stateDirectory, fence }),
                  driverLayer({ fence, workspaceRoot: workspace, workspaceUser }),
                ),
              ),
            )
            const context = yield* Layer.buildWithScope(managerLayer, scope).pipe(Effect.provide(services))
            return Context.get(context, Manager)
          })
          const firstScope = yield* Scope.make()
          const firstManager = yield* buildManager(firstScope)
          yield* Effect.addFinalizer(() => firstManager.terminate("pty-proc").pipe(Effect.ignore))
          yield* firstManager.create({
            ptyId: "pty-proc",
            command: "bash --noprofile --norc",
            cwd: workspace,
            cols: 80,
            rows: 24,
          })
          yield* firstManager.input({ ptyId: "pty-proc", data: "printf FIRST_MARKER\n" })
          const first: Connection = yield* waitForOutput(firstManager, 0, "FIRST_MARKER")
          yield* firstManager.disconnect("pty-proc")
          yield* Scope.close(firstScope, Exit.void)

          const secondScope = yield* Scope.make()
          yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void))
          const secondManager = yield* buildManager(secondScope)
          const reattached = yield* secondManager.reconnect({ ptyId: "pty-proc", cursor: first.cursor })
          expect(reattached.connected).toBe(true)
          yield* secondManager.resize({ ptyId: "pty-proc", cols: 100, rows: 32 })
          yield* secondManager.input({ ptyId: "pty-proc", data: "printf SECOND_MARKER\n" })
          const second = yield* waitForOutput(secondManager, first.cursor, "SECOND_MARKER")
          expect(second.transcript.map((chunk) => chunk.cursor)).toEqual(
            [...second.transcript].map((chunk) => chunk.cursor).sort((left, right) => left - right),
          )
          expect(second.transcript.some((chunk) => chunk.data.includes("FIRST_MARKER"))).toBe(false)
          expect(yield* secondManager.terminate("pty-proc")).toMatchObject({ connected: false, terminated: true })
        }),
      ),
    15_000,
  )
})
