import { createArchive } from "@rika/remote-execution/workspace-archive"
import { Effect } from "effect"
import { gitOutput } from "../../platform/git"
import { HostedError } from "../contract"

const failure = (message: string) => HostedError.make({ kind: "invalid-input", message })

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
  const root = (yield* gitOutput(workspace, ["rev-parse", "--show-toplevel"])) ?? workspace
  const [archive, remote] = yield* Effect.all(
    [
      createArchive(root).pipe(
        Effect.mapError((error) => failure(`Could not seed the local Workspace: ${error.message}`)),
      ),
      gitOutput(root, ["remote", "get-url", "origin"]),
    ],
    { concurrency: 2 },
  )
  const repository = sourceRepository(remote)
  return repository === undefined ? { archive } : { archive, sourceRepository: repository }
})
