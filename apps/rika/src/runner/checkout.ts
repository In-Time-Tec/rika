import { createHash } from "node:crypto"
import { DeviceId, WorkspaceId } from "@rika/product/hosted-model"
import { CheckoutFingerprint, runnerProtocolVersion } from "@rika/product/runner-registration"
import { Effect, FileSystem } from "effect"
import { gitOutput } from "../platform/git"
import type { RunnerRegistration, RemoteThreadCreation } from "./contract"
import { RunnerError } from "./contract"

export interface RunnerCheckout {
  readonly registration: RunnerRegistration
  readonly workspacePath: string
}

const digest = (parts: ReadonlyArray<string>) => createHash("sha256").update(parts.join("\0")).digest("base64url")

const safeRemote = (value: string | undefined) => {
  if (value === undefined) return undefined
  try {
    const url = new URL(value)
    url.username = ""
    url.password = ""
    return url.toString()
  } catch {
    return value.replace(/^[^@\s]+@([^:]+):/, "ssh://$1/")
  }
}

export const inspectRunnerCheckout = Effect.fn("RunnerCheckout.inspect")(function* (input: {
  readonly deviceId: string
  readonly workspace: string
  readonly remoteThreadCreation: RemoteThreadCreation
}) {
  const fileSystem = yield* FileSystem.FileSystem
  const workspacePath = yield* fileSystem
    .realPath(input.workspace)
    .pipe(Effect.mapError(() => RunnerError.make({ message: "Could not inspect the local checkout" })))
  const root = (yield* gitOutput(workspacePath, ["rev-parse", "--show-toplevel"])) ?? workspacePath
  const checkoutPath = yield* fileSystem
    .realPath(root)
    .pipe(Effect.mapError(() => RunnerError.make({ message: "Could not inspect the local checkout" })))
  const [commonDirectoryValue, remoteUrlValue, headRevision, branch] = yield* Effect.all(
    [
      gitOutput(checkoutPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      gitOutput(checkoutPath, ["remote", "get-url", "origin"]),
      gitOutput(checkoutPath, ["rev-parse", "HEAD"]),
      gitOutput(checkoutPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    ],
    { concurrency: 4 },
  )
  const commonDirectory = commonDirectoryValue ?? checkoutPath
  const repositoryPath = yield* fileSystem.realPath(commonDirectory).pipe(Effect.orElseSucceed(() => commonDirectory))
  const remoteUrl = safeRemote(remoteUrlValue)
  const repositoryIdentity = digest([remoteUrl ?? repositoryPath])
  const checkoutFingerprint = digest([input.deviceId, checkoutPath, repositoryIdentity])
  const workspaceIdentity = `runner:${digest([input.deviceId, checkoutFingerprint])}`
  const repository: RunnerRegistration["repository"] = { identity: repositoryIdentity }
  if (remoteUrl !== undefined) Object.assign(repository, { remoteUrl })
  if (headRevision !== undefined) Object.assign(repository, { headRevision })
  if (branch !== undefined) Object.assign(repository, { branch })
  return {
    workspacePath: checkoutPath,
    registration: {
      protocolVersion: runnerProtocolVersion,
      deviceId: DeviceId.make(input.deviceId),
      checkoutFingerprint: CheckoutFingerprint.make(checkoutFingerprint),
      repository,
      workspaceIdentity: WorkspaceId.make(workspaceIdentity),
      nativeToolRuntime: {
        runtime: "bun",
        runtimeVersion: process.versions.bun ?? "unknown",
        trustMode: "trusted-local",
      },
      capabilities: { nativeTools: true, checkpoints: false, pty: false },
      remoteThreadCreation: input.remoteThreadCreation,
    },
  } satisfies RunnerCheckout
})
