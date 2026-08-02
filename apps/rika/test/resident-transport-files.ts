import { Effect, FileSystem } from "effect"
import { FixtureFailure } from "./resident-transport-runtime"

export const cleanRoot = (root: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.remove(root, { recursive: true, force: true })),
    Effect.mapError((cause) => new FixtureFailure({ operation: "clean fixture root", cause })),
  )

export const readText = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.readFileString(path))
export const fileStat = (path: string) => Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.stat(path))
export const fileExists = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.exists(path))
