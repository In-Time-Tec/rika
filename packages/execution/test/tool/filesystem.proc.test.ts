import * as BunServices from "@effect/platform-bun/BunServices"
import * as ToolRuntime from "@rika/product/native-tool-runtime"
import { expect, test } from "vitest"
import { Effect, FileSystem, Layer } from "effect"
import * as NativeRuntime from "../../src/tool/runtime"
import { provide } from "./support"

test("runs the four native operations against a real workspace and process", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-native-tools-" })
        const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-native-tools-outside-" })
        yield* fileSystem.makeDirectory(`${workspace}/src`, { recursive: true })
        yield* fileSystem.writeFileString(`${workspace}/src/a.ts`, "alpha\nbeta\nalpha")
        yield* fileSystem.writeFileString(`${outside}/outside.txt`, "outside")
        const result = yield* Effect.gen(function* () {
          const runtime = yield* ToolRuntime.Service
          const read = yield* runtime.run({ _tag: "Read", path: "src/a.ts", readRange: [2, 2] })
          const outsideRead = yield* runtime.run({ _tag: "Read", path: `${outside}/outside.txt` })
          const edit = yield* runtime.run({ _tag: "Edit", path: "src/a.ts", oldStr: "beta", newStr: "changed" })
          const refused = yield* Effect.flip(runtime.run({ _tag: "Bash", command: "rm -rf /" }))
          const started = yield* runtime.run({
            _tag: "Bash",
            command: `bun -e 'console.log("ready");setTimeout(()=>console.log("done"),20)'`,
            timeoutMillis: 0,
          })
          const status = yield* runtime.run({
            _tag: "ShellCommandStatus",
            processId: started.processId ?? "",
            waitMillis: 1_000,
          })
          return { read, outsideRead, edit, refused, started, status }
        }).pipe(provide(NativeRuntime.layer(workspace).pipe(Layer.provide(BunServices.layer))))
        expect(result.read.text).toBe("2: beta")
        expect(result.outsideRead.text).toBe("1: outside")
        expect(result.edit.diff).toContain("+changed")
        expect(result.refused).toMatchObject({ category: "access_denied", outcome: "known", recovery: "never" })
        expect(result.started.running).toBe(true)
        expect(result.status).toMatchObject({ processId: result.started.processId, running: false, exitCode: 0 })
        expect(`${result.started.text}${result.status.text}`).toContain("ready")
        expect(`${result.started.text}${result.status.text}`).toContain("done")
        expect(yield* fileSystem.readFileString(`${workspace}/src/a.ts`)).toBe("alpha\nchanged\nalpha")
      }).pipe(provide(BunServices.layer)),
    ),
  ))
