import { createArchive } from "@rika/remote-execution/workspace-archive"
import { Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { HostedError } from "../contract"

const failure = (message: string) => HostedError.make({ kind: "invalid-input", message })

const git = Effect.fn("HostedWorkspaceSeed.git")(function* (workspace: string, arguments_: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner
        .spawn(ChildProcess.make("git", ["-C", workspace, ...arguments_], { stdout: "pipe", stderr: "ignore" }))
        .pipe(Effect.option)
      if (child._tag === "None") return undefined
      const result = yield* Effect.all([Stream.mkString(Stream.decodeText(child.value.stdout)), child.value.exitCode], {
        concurrency: 2,
      }).pipe(Effect.option)
      if (result._tag === "None") return undefined
      const [output, exitCode] = result.value
      if (Number(exitCode) !== 0) return undefined
      const value = output.trim()
      return value.length === 0 ? undefined : value
    }),
  )
})

export const sourceRepository = (remote: string | undefined) => {
  if (remote === undefined) return undefined
  const scp = remote.match(/^(?:[^@\s]+@)?github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i)
  if (scp !== null) return { owner: scp[1]!, name: scp[2]! }
  try {
    const url = new URL(remote)
    if (url.hostname.toLowerCase() !== "github.com") return undefined
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/")
    if (parts.length !== 2 || parts.some((part) => part.length === 0)) return undefined
    return { owner: parts[0]!, name: parts[1]!.replace(/\.git$/i, "") }
  } catch {
    return undefined
  }
}

export const prepareWorkspaceSeed = Effect.fn("HostedWorkspaceSeed.prepare")(function* (workspace: string) {
  const root = (yield* git(workspace, ["rev-parse", "--show-toplevel"])) ?? workspace
  const [archive, remote] = yield* Effect.all(
    [
      createArchive(root).pipe(
        Effect.mapError((error) => failure(`Could not seed the local Workspace: ${error.message}`)),
      ),
      git(root, ["remote", "get-url", "origin"]),
    ],
    { concurrency: 2 },
  )
  const repository = sourceRepository(remote)
  return repository === undefined ? { archive } : { archive, sourceRepository: repository }
})
