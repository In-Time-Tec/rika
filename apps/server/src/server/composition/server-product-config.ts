import * as ConfigOperations from "@rika/product/configuration-operation"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"

export const adapter = (editor: string | undefined) =>
  Layer.effect(
    ConfigOperations.Adapter,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      return ConfigOperations.Adapter.of({
        exists: (filename) =>
          fileSystem
            .exists(filename)
            .pipe(Effect.mapError((error) => ConfigOperations.AdapterError.make({ message: String(error) }))),
        edit: (filename) =>
          Effect.scoped(
            Effect.gen(function* () {
              if (editor === undefined)
                return yield* ConfigOperations.AdapterError.make({
                  message: "Set VISUAL or EDITOR to edit configuration",
                })
              yield* fileSystem.makeDirectory(path.dirname(filename), { recursive: true })
              if (!(yield* fileSystem.exists(filename))) yield* fileSystem.writeFileString(filename, "{}\n")
              const handle = yield* spawner.spawn(ChildProcess.make(editor, [filename]))
              const code = yield* handle.exitCode
              if (Number(code) !== 0)
                return yield* ConfigOperations.AdapterError.make({ message: `Editor exited with status ${code}` })
            }),
          ).pipe(
            Effect.mapError((error) =>
              Schema.is(ConfigOperations.AdapterError)(error)
                ? error
                : ConfigOperations.AdapterError.make({ message: String(error) }),
            ),
          ),
      })
    }),
  )
