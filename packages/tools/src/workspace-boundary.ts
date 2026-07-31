import { Effect, Function, type FileSystem, type Path } from "effect"

export const pathContainedIn: {
  (candidate: string, path: Path.Path): (root: string) => boolean
  (root: string, candidate: string, path: Path.Path): boolean
} = Function.dual(3, (root: string, candidate: string, path: Path.Path): boolean => {
  if (candidate === root) return true
  const relative = path.relative(root, candidate)
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
})

export const containedRelativePath: {
  (
    relativePath: string,
    path: Path.Path,
    fileSystem: FileSystem.FileSystem,
  ): (root: string) => Effect.Effect<boolean, import("effect/PlatformError").PlatformError>
  (
    root: string,
    relativePath: string,
    path: Path.Path,
    fileSystem: FileSystem.FileSystem,
  ): Effect.Effect<boolean, import("effect/PlatformError").PlatformError>
} = Function.dual(
  4,
  (
    root: string,
    relativePath: string,
    path: Path.Path,
    fileSystem: FileSystem.FileSystem,
  ): Effect.Effect<boolean, import("effect/PlatformError").PlatformError> =>
    Effect.gen(function* () {
      const absolute = path.resolve(root, relativePath)
      const exists = yield* fileSystem.exists(absolute)
      if (!exists) return false
      const canonical = yield* fileSystem.realPath(absolute).pipe(Effect.orElseSucceed(() => absolute))
      return pathContainedIn(root, canonical, path)
    }),
)
