import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, FileSystem } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as MachineProcess from "../src/machine-process"
import { provideLayer } from "./support/layer"

describe("workspace machine process", () => {
  it.live(
    "keeps files, environment, and background processes in the delegated user process",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-machine-process-" })
          const username = (yield* spawner.string(ChildProcess.make("id", ["-un"]))).trim()
          const machine = yield* MachineProcess.make({
            workspace,
            workspaceUser: username,
            environment: { RIKA_MACHINE_TEST: "delegated-environment" },
          })
          const written = yield* machine.execute({
            _tag: "CodingTool",
            request: { _tag: "Write", path: "delegated.txt", content: "delegated-content" },
          })
          expect(written._tag).toBe("Success")
          expect(yield* fileSystem.readFileString(`${workspace}/delegated.txt`)).toBe("delegated-content")

          const environment = yield* machine.execute({
            _tag: "CodingTool",
            request: { _tag: "Bash", command: 'printf "%s" "$RIKA_MACHINE_TEST"' },
          })
          expect(
            environment._tag === "Success" && environment.value._tag === "CodingTool"
              ? environment.value.result.text
              : "",
          ).toBe("delegated-environment")

          const started = yield* machine.execute({
            _tag: "CodingTool",
            request: { _tag: "Bash", command: "sleep 0.1; printf background-complete", timeoutMillis: 0 },
          })
          const processId =
            started._tag === "Success" &&
            started.value._tag === "CodingTool" &&
            typeof started.value.result.processId === "string"
              ? started.value.result.processId
              : ""
          expect(processId).not.toBe("")
          const completed = yield* machine.execute({
            _tag: "CodingTool",
            request: { _tag: "ShellCommandStatus", processId, waitMillis: 1_000 },
          })
          expect(
            completed._tag === "Success" && completed.value._tag === "CodingTool" ? completed.value.result.text : "",
          ).toContain("background-complete")

          const interrupted = yield* Effect.forkChild(
            machine.execute({
              _tag: "CodingTool",
              request: {
                _tag: "Bash",
                command: "sleep 1; printf late > interrupted.txt",
                timeoutMillis: 5_000,
              },
            }),
          )
          yield* Effect.sleep("100 millis")
          yield* Fiber.interrupt(interrupted)
          yield* Effect.sleep("1200 millis")
          expect(yield* fileSystem.exists(`${workspace}/interrupted.txt`)).toBe(false)
          const afterCancellation = yield* machine.execute({
            _tag: "CodingTool",
            request: { _tag: "Write", path: "after-cancellation.txt", content: "still-ready" },
          })
          expect(afterCancellation._tag).toBe("Success")
          expect(yield* fileSystem.readFileString(`${workspace}/after-cancellation.txt`)).toBe("still-ready")

          const crashed = yield* Effect.result(
            machine.execute({
              _tag: "CodingTool",
              request: { _tag: "Bash", command: 'kill -KILL "$PPID" "$$"', timeoutMillis: 5_000 },
            }),
          )
          expect(crashed._tag).toBe("Failure")
          const recovered = yield* machine.execute({
            _tag: "CodingTool",
            request: { _tag: "Write", path: "recovered.txt", content: "recovered" },
          })
          expect(recovered._tag).toBe("Success")
          expect(yield* fileSystem.readFileString(`${workspace}/recovered.txt`)).toBe("recovered")
        }).pipe(provideLayer(BunServices.layer)),
      ),
    20_000,
  )
})
