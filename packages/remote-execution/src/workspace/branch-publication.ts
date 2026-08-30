import { Clock, Config, Crypto, Effect, Encoding, FileSystem, Option } from "effect"
import type { BranchPushOutcome, BranchPushRequest } from "../protocol/messages"
import { WorkspaceCommand } from "./command-adapter"
import { CredentialBroker, type Credential } from "./credential-broker"

export const RemoteRepositoryRoot = "/home/rika-workspace/workspace/repo"
export const EphemeralCredentialRoot = "/run/rika"

export interface BranchPushOptions {
  readonly request: BranchPushRequest
  readonly repositoryUrl: string
  readonly credential: Credential
  readonly root?: string
  readonly workspaceCommandPrefix?: ReadonlyArray<string>
  readonly credentialRoot?: string
}

const approvedBranchRefIsValid = (request: BranchPushRequest) =>
  request.ref === `refs/heads/${request.branch}` &&
  /^rika\/[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/.test(request.branch) &&
  !request.branch.includes("..") &&
  !request.branch.includes("//") &&
  !request.branch.includes("@{") &&
  !request.branch.endsWith(".lock")

const credentialScopeIsValid = (options: BranchPushOptions, now: number) =>
  options.credential.repositoryUrl === options.repositoryUrl &&
  options.credential.expiresAt > now &&
  options.credential.expiresAt <= now + 60 * 60 * 1_000

const workspaceMatchesApproval = Effect.fn("Workspace.workspaceMatchesApproval")(function* (
  options: BranchPushOptions,
  root: string,
  run: (command: ReadonlyArray<string>) => ReturnType<typeof WorkspaceCommand.run>,
) {
  const request = options.request
  const head = yield* run(["git", "-C", root, "rev-parse", "HEAD"]).pipe(Effect.option)
  const remote = yield* run(["git", "-C", root, "remote", "get-url", "origin"]).pipe(Effect.option)
  const pushRemote = yield* run(["git", "-C", root, "remote", "get-url", "--push", "origin"]).pipe(Effect.option)
  const localAuthority = yield* run([
    "git",
    "-C",
    root,
    "config",
    "--local",
    "--includes",
    "--name-only",
    "--get-regexp",
    "^(http\\.|remote\\.origin\\.(pushurl|receivepack|proxy|mirror)$|url\\.|credential\\.)",
  ]).pipe(Effect.option)
  const localAuthorityKeys = Option.isSome(localAuthority)
    ? localAuthority.value.output
        .trim()
        .split("\n")
        .filter((name) => name.length > 0 && name !== "credential.helper" && name !== "credential.usehttppath")
    : []
  return (
    Option.isSome(head) &&
    Option.isSome(remote) &&
    Option.isSome(pushRemote) &&
    Option.isSome(localAuthority) &&
    head.value.code === 0 &&
    remote.value.code === 0 &&
    pushRemote.value.code === 0 &&
    (localAuthority.value.code === 0 || localAuthority.value.code === 1) &&
    head.value.output.trim() === request.commitSha &&
    remote.value.output.trim() === options.repositoryUrl &&
    pushRemote.value.output.trim() === options.repositoryUrl &&
    localAuthorityKeys.length === 0
  )
})

export const pushApprovedBranch = Effect.fn("Workspace.pushApprovedBranch")(function* (options: BranchPushOptions) {
  const path = yield* Config.string("PATH").pipe(Config.withDefault("/usr/local/bin:/usr/bin:/bin"))
  const fileSystem = yield* FileSystem.FileSystem
  const crypto = yield* Crypto.Crypto
  const root = options.root ?? RemoteRepositoryRoot
  const prefix = options.workspaceCommandPrefix ?? []
  const credentialRoot = options.credentialRoot ?? EphemeralCredentialRoot
  const request = options.request
  const failed = (kind: "stale" | "local" | "git", message: string): BranchPushOutcome => ({
    _tag: "Failed",
    kind,
    message,
  })
  if (!approvedBranchRefIsValid(request)) return failed("stale", "Approved branch ref is invalid")
  const now = yield* Clock.currentTimeMillis
  if (!credentialScopeIsValid(options, now)) return failed("stale", "Branch push credential scope is invalid")
  const run = (command: ReadonlyArray<string>) =>
    WorkspaceCommand.run(
      [...prefix, ...command],
      root,
      {
        PATH: path,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
        GIT_ASKPASS: "/bin/false",
        SSH_ASKPASS: "/bin/false",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      () => Effect.void,
    )
  if (!(yield* workspaceMatchesApproval(options, root, run)))
    return failed("stale", "Workspace HEAD or repository changed after approval")
  const digest = Encoding.encodeHex(
    yield* crypto.digest("SHA-256", new TextEncoder().encode(request.publicationId)).pipe(Effect.orDie),
  )
  const directory = `${credentialRoot}/publication-${digest}`
  const socketPath = `${directory}/credential.sock`
  const clientPath = `${directory}/credential-client.js`
  const helperPath = `${directory}/git-credential-rika-push`
  const snapshot = `${directory}/repository.git`
  let available: Credential | undefined = options.credential
  let broker: ReturnType<typeof CredentialBroker.listen> | undefined
  return yield* Effect.gen(function* () {
    yield* fileSystem.remove(directory, { recursive: true, force: true })
    yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 })
    const initialized = yield* run(["git", "init", "--bare", snapshot])
    if (initialized.code !== 0) return failed("local", "Approved branch snapshot could not start")
    const fetched = yield* run([
      "git",
      `--git-dir=${snapshot}`,
      "-c",
      `safe.directory=${root}`,
      "fetch",
      "--no-tags",
      root,
      "HEAD",
    ])
    if (fetched.code !== 0) return failed("stale", "Workspace HEAD changed while publication was isolated")
    const snapshotHead = yield* run(["git", `--git-dir=${snapshot}`, "rev-parse", "FETCH_HEAD"])
    if (snapshotHead.code !== 0 || snapshotHead.output.trim() !== request.commitSha)
      return failed("stale", "Workspace HEAD changed while publication was isolated")
    for (const command of [
      ["git", `--git-dir=${snapshot}`, "update-ref", "refs/heads/publication", request.commitSha],
      ["git", `--git-dir=${snapshot}`, "symbolic-ref", "HEAD", "refs/heads/publication"],
      ["git", `--git-dir=${snapshot}`, "remote", "add", "origin", options.repositoryUrl],
    ]) {
      const configured = yield* run(command)
      if (configured.code !== 0) return failed("local", "Approved branch snapshot could not be sealed")
    }
    broker = yield* Effect.try({
      try: () =>
        CredentialBroker.listen(socketPath, (purpose) => {
          if (purpose !== "branch-push") return undefined
          const current = available
          available = undefined
          return current
        }),
      catch: () => undefined,
    })
    if (broker === undefined) return failed("local", "Branch push credential broker could not start")
    yield* fileSystem.chmod(socketPath, 0o600)
    yield* fileSystem.writeFileString(clientPath, CredentialBroker.clientSource(socketPath), { mode: 0o700 })
    yield* fileSystem.writeFileString(
      helperPath,
      `#!/bin/sh\nset -eu\ncase "\${1:-}" in get) exec ${clientPath} branch-push ;; *) exit 0 ;; esac\n`,
      { mode: 0o700 },
    )
    const pushed = yield* run([
      "git",
      `--git-dir=${snapshot}`,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "credential.helper=",
      "-c",
      `credential.helper=${helperPath}`,
      "-c",
      "credential.useHttpPath=true",
      "-c",
      "credential.interactive=false",
      "-c",
      "http.extraHeader=",
      "-c",
      "http.cookieFile=",
      "push",
      "--porcelain",
      "origin",
      `HEAD:${request.ref}`,
    ]).pipe(Effect.timeoutOption("45 seconds"), Effect.orElseSucceed(Option.none))
    if (Option.isNone(pushed) || pushed.value.code !== 0) return failed("git", "Git rejected the approved branch push")
    return { _tag: "Succeeded", branch: request.branch, ref: request.ref, commitSha: request.commitSha } as const
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => broker?.stop(true)).pipe(
        Effect.andThen(fileSystem.remove(directory, { recursive: true, force: true })),
        Effect.ignore,
      ),
    ),
    Effect.orElseSucceed(() => failed("local", "Approved branch push could not run")),
  )
})
