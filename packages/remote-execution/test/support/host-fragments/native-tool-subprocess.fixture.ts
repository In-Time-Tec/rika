import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, FileSystem } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as NativeToolSubprocess from "../../../src/host/machinery/native-tool-subprocess"
import { provideLayer } from "../layer"

describe("workspace native tool subprocess", () => {
  it.live(
    "keeps files, environment, and background processes in the delegated user process",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-native-tool-subprocess-" })
          const username = (yield* spawner.string(ChildProcess.make("id", ["-un"]))).trim()
          const nativeTool = yield* NativeToolSubprocess.make({
            workspace,
            workspaceUser: username,
            environment: { RIKA_NATIVE_TOOL_TEST: "delegated-environment" },
          })
          const written = yield* nativeTool.execute({
            _tag: "Bash",
            command: "printf delegated-content > delegated.txt",
          })
          expect(written._tag).toBe("Success")
          expect(yield* fileSystem.readFileString(`${workspace}/delegated.txt`)).toBe("delegated-content")

          const environment = yield* nativeTool.execute({
            _tag: "Bash",
            command: 'printf "%s" "$RIKA_NATIVE_TOOL_TEST"',
          })
          expect(
            environment._tag === "Success" && environment.value._tag === "NativeTool"
              ? environment.value.result.text
              : "",
          ).toBe("delegated-environment")

          const started = yield* nativeTool.execute({
            _tag: "Bash",
            command: "sleep 0.1; printf background-complete",
            timeoutMillis: 0,
          })
          const processId =
            started._tag === "Success" && started.value._tag === "NativeTool"
              ? (started.value.result.processId ?? "")
              : ""
          expect(processId).not.toBe("")
          const completed = yield* nativeTool.execute({
            _tag: "ShellCommandStatus",
            processId,
            waitMillis: 1_000,
          })
          expect(
            completed._tag === "Success" && completed.value._tag === "NativeTool" ? completed.value.result.text : "",
          ).toContain("background-complete")

          const interrupted = yield* Effect.forkChild(
            nativeTool.execute({
              _tag: "Bash",
              command: "sleep 1; printf late > interrupted.txt",
              timeoutMillis: 5_000,
            }),
          )
          yield* Effect.sleep("100 millis")
          yield* Fiber.interrupt(interrupted)
          yield* Effect.sleep("1200 millis")
          expect(yield* fileSystem.exists(`${workspace}/interrupted.txt`)).toBe(false)
          const afterCancellation = yield* nativeTool.execute({
            _tag: "Bash",
            command: "printf still-ready > after-cancellation.txt",
          })
          expect(afterCancellation._tag).toBe("Success")
          expect(yield* fileSystem.readFileString(`${workspace}/after-cancellation.txt`)).toBe("still-ready")

          const crashed = yield* Effect.result(
            nativeTool.execute({
              _tag: "Bash",
              command: 'kill -KILL "$PPID" "$$"',
              timeoutMillis: 5_000,
            }),
          )
          expect(crashed._tag).toBe("Failure")
          const recovered = yield* nativeTool.execute({
            _tag: "Bash",
            command: "printf recovered > recovered.txt",
          })
          expect(recovered._tag).toBe("Success")
          expect(yield* fileSystem.readFileString(`${workspace}/recovered.txt`)).toBe("recovered")
        }).pipe(provideLayer(BunServices.layer)),
      ),
    20_000,
  )
})
