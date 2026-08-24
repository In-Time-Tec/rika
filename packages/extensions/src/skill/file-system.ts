import { Context, Effect, FileSystem, Function, Layer, Path, PlatformError } from "effect"

export interface FileSystemInterface {
  readonly exists: (path: string) => Effect.Effect<boolean, PlatformError.PlatformError>
  readonly readDirectory: (path: string) => Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError>
  readonly readFileString: (path: string) => Effect.Effect<string, PlatformError.PlatformError>
  readonly isFile: (path: string) => Effect.Effect<boolean, PlatformError.PlatformError>
  readonly realPath: (path: string) => Effect.Effect<string, PlatformError.PlatformError>
}

export class SkillFileSystem extends Context.Service<SkillFileSystem, FileSystemInterface>()(
  "@rika/extensions/skill/file-system/SkillFileSystem",
) {}

export const fileSystemLayer = Layer.effect(
  SkillFileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    return SkillFileSystem.of({
      exists: (path) => fileSystem.exists(path),
      readDirectory: (path) => fileSystem.readDirectory(path, { recursive: true }),
      readFileString: (path) => fileSystem.readFileString(path),
      isFile: (path) => fileSystem.stat(path).pipe(Effect.map((info) => info.type === "File")),
      realPath: (path) => fileSystem.realPath(path),
    })
  }),
)

const fileSystemTestLayerImpl = (
  files: Readonly<Record<string, string>>,
  directories: Readonly<Record<string, ReadonlyArray<string>>>,
) =>
  Layer.effect(
    SkillFileSystem,
    Effect.gen(function* () {
      const path = yield* Path.Path
      const normalizedFiles = new Map(Object.entries(files).map(([name, content]) => [path.resolve(name), content]))
      const normalizedDirectories = new Map(
        Object.entries(directories).map(([name, entries]) => [path.resolve(name), entries]),
      )
      return SkillFileSystem.of({
        exists: (name) =>
          Effect.succeed(normalizedFiles.has(path.resolve(name)) || normalizedDirectories.has(path.resolve(name))),
        readDirectory: (name) => {
          const entries = normalizedDirectories.get(path.resolve(name))
          return entries === undefined ? Effect.die(`Missing test directory: ${name}`) : Effect.succeed(entries)
        },
        readFileString: (name) => {
          const content = normalizedFiles.get(path.resolve(name))
          return content === undefined ? Effect.die(`Missing test file: ${name}`) : Effect.succeed(content)
        },
        isFile: (name) => Effect.succeed(normalizedFiles.has(path.resolve(name))),
        realPath: (name) => Effect.succeed(path.resolve(name)),
      })
    }),
  )

export const fileSystemTestLayer: {
  (
    files: Readonly<Record<string, string>>,
  ): (directories: Readonly<Record<string, ReadonlyArray<string>>>) => Layer.Layer<SkillFileSystem, never, Path.Path>
  (
    files: Readonly<Record<string, string>>,
    directories: Readonly<Record<string, ReadonlyArray<string>>>,
  ): Layer.Layer<SkillFileSystem, never, Path.Path>
} = Function.dual(2, fileSystemTestLayerImpl)
