import { createHash } from "node:crypto"
import { DeviceId, WorkspaceId } from "@rika/product/hosted-model"
import { CheckoutFingerprint } from "@rika/product/local-runner-registration"
import { Effect, FileSystem, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import type { LocalRunnerRegistration, RemoteThreadCreation } from "./local-runner-contract"
import { LocalRunnerError } from "./local-runner-contract"

export interface LocalCheckout {
  readonly registration: LocalRunnerRegistration
  readonly workspacePath: string
}

const digest = (parts: ReadonlyArray<string>) => createHash("sha256").update(parts.join("\0")).digest("base64url")

const runGit = Effect.fn("LocalCheckout.git")(function* (workspace: string, arguments_: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const child = yield* spawner
    .spawn(ChildProcess.make("git", ["-C", workspace, ...arguments_], { stdout: "pipe", stderr: "ignore" }))
    .pipe(Effect.mapError(() => LocalRunnerError.make({ message: "Could not inspect the local checkout" })))
  const [text, exitCode] = yield* Effect.all(
    [Stream.mkString(Stream.decodeText(child.stdout)), child.exitCode],
    { concurrency: 2 },
  ).pipe(Effect.mapError(() => LocalRunnerError.make({ message: "Could not inspect the local checkout" })))
  const trimmed = text.trim()
  return Number(exitCode) === 0 && trimmed.length > 0 ? trimmed : undefined
})

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

export const inspectLocalCheckout = Effect.fn("LocalCheckout.inspect")(function* (input: {
  readonly deviceId: string
  readonly workspace: string
  readonly remoteThreadCreation: RemoteThreadCreation
}) {
  const fileSystem = yield* FileSystem.FileSystem
  const workspacePath = yield* fileSystem
    .realPath(input.workspace)
    .pipe(Effect.mapError(() => LocalRunnerError.make({ message: "Could not inspect the local checkout" })))
  const root = (yield* runGit(workspacePath, ["rev-parse", "--show-toplevel"])) ?? workspacePath
  const checkoutPath = yield* fileSystem
    .realPath(root)
    .pipe(Effect.mapError(() => LocalRunnerError.make({ message: "Could not inspect the local checkout" })))
  const commonDirectory =
    (yield* runGit(checkoutPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) ?? checkoutPath
  const repositoryPath = yield* fileSystem.realPath(commonDirectory).pipe(Effect.orElseSucceed(() => commonDirectory))
  const remoteUrl = safeRemote(yield* runGit(checkoutPath, ["remote", "get-url", "origin"]))
  const headRevision = yield* runGit(checkoutPath, ["rev-parse", "HEAD"])
  const branch = yield* runGit(checkoutPath, ["symbolic-ref", "--quiet", "--short", "HEAD"])
  const repositoryIdentity = digest([remoteUrl ?? repositoryPath])
  const checkoutFingerprint = digest([input.deviceId, checkoutPath, repositoryIdentity])
  const workspaceIdentity = `local:${digest([input.deviceId, checkoutFingerprint])}`
  return {
    workspacePath: checkoutPath,
    registration: {
      deviceId: DeviceId.make(input.deviceId),
      checkoutFingerprint: CheckoutFingerprint.make(checkoutFingerprint),
      repository: {
        identity: repositoryIdentity,
        ...(remoteUrl === undefined ? {} : { remoteUrl }),
        ...(headRevision === undefined ? {} : { headRevision }),
        ...(branch === undefined ? {} : { branch }),
      },
      workspaceIdentity: WorkspaceId.make(workspaceIdentity),
      kernel: { runtime: "bun", runtimeVersion: process.versions.bun, trustMode: "trusted-local" },
      capabilities: { cells: true, checkpoints: false, pty: false },
      remoteThreadCreation: input.remoteThreadCreation,
    },
  } satisfies LocalCheckout
})
