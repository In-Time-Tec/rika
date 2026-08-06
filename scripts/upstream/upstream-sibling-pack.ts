import { Effect, FileSystem, Path } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { directoryDigest, fileDigest } from "./upstream-content-digest"

const spawn = Effect.fn("Upstream.spawn")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options?: { readonly cwd: string },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const exitCode = yield* spawner.exitCode(
    options === undefined ? ChildProcess.make(command, args) : ChildProcess.make(command, args, { cwd: options.cwd }),
  )
  return Number(exitCode)
})

// `bun pm pack` normalizes entry timestamps and modes, so packing an unchanged worktree twice
// produces byte-identical archives. Re-linking unchanged sources is therefore a no-op instead of
// a lockfile churn, which is what lets the digest double as a content identity.
export const packSibling = Effect.fn("Upstream.packSibling")(function* (source: string, destination: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if ((yield* spawn("bun", ["pm", "pack", "--destination", destination], { cwd: source })) !== 0) return undefined
  const packed = (yield* fileSystem.readDirectory(destination)).find((entry) => entry.endsWith(".tgz"))
  if (packed === undefined) return undefined
  const file = path.join(destination, packed)
  return { file, name: packed, digest: yield* fileDigest(file) }
})

export const extractedDigest = Effect.fn("Upstream.extractedDigest")(function* (tarball: string, destination: string) {
  const path = yield* Path.Path
  if ((yield* spawn("tar", ["-xzf", tarball, "-C", destination])) !== 0) return undefined
  return yield* directoryDigest(path.join(destination, "package"))
})
