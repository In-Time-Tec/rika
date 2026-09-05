import { WorkspaceCapability, WorkspaceCapabilitySnapshot } from "@rika/product/executor-assignment"
import * as Mcp from "@rika/execution/mcp-tools"
import { Clock, Crypto, DateTime, Effect, Encoding, FileSystem, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const ready = (detail: string): WorkspaceCapability => ({ _tag: "Ready", detail })
const unavailable = (reason: string): WorkspaceCapability => ({ _tag: "Unavailable", reason })
const encodeIdentity = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      target: Schema.Literals(["runner", "orb"]),
      workspacePath: Schema.String,
      bun: Schema.String,
      gitExecutable: Schema.NullOr(Schema.String),
      browserExecutable: Schema.NullOr(Schema.String),
      agentBrowserExecutable: Schema.NullOr(Schema.String),
      states: Schema.Struct({
        filesystem: WorkspaceCapability,
        nativeTools: WorkspaceCapability,
        git: WorkspaceCapability,
        process: WorkspaceCapability,
        pty: WorkspaceCapability,
        browser: WorkspaceCapability,
        services: WorkspaceCapability,
        workspaceLifecycle: WorkspaceCapability,
        mcp: WorkspaceCapabilitySnapshot.fields.mcp,
      }),
    }),
  ),
)

/**
 * Whether `path` is a directory as seen by `user`. An Orb host runs as a different user than the
 * workspace owner and may not traverse the workspace parent, so a direct stat is not enough.
 */
export const directoryVisibleTo = (input: {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  readonly user: string
  readonly path: string
}): Effect.Effect<boolean> =>
  Effect.scoped(
    Effect.gen(function* () {
      const process = yield* input.spawner.spawn(
        ChildProcess.make("sudo", ["-n", "-u", input.user, "--", "test", "-d", input.path], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      return Number(yield* process.exitCode) === 0
    }),
  ).pipe(Effect.orElseSucceed(() => false))

const inspectMcp = (input: {
  readonly workspacePath: string
  readonly mcp?: Effect.Effect<NonNullable<WorkspaceCapabilitySnapshot["mcp"]>>
}) =>
  input.mcp ??
  Mcp.capture(input.workspacePath).pipe(
    Effect.map((catalog) => ({ _tag: "Ready" as const, catalog })),
    Effect.orElseSucceed(() => ({
      _tag: "Unavailable" as const,
      reason: "MCP discovery failed; check Executor-local configuration",
    })),
  )

export const inspectWorkspaceCapabilities = Effect.fn("WorkspaceCapabilities.inspect")(function* (input: {
  readonly target: "runner" | "orb"
  readonly workspacePath: string
  readonly nativeTools: boolean
  readonly pty: boolean
  readonly browser?: boolean
  readonly services?: boolean
  /** A fallback directory probe, such as `directoryVisibleTo`, used when a direct stat of the workspace fails. */
  readonly workspaceVisible?: Effect.Effect<boolean>
  readonly mcp?: Effect.Effect<NonNullable<WorkspaceCapabilitySnapshot["mcp"]>>
}) {
  const fileSystem = yield* FileSystem.FileSystem
  const crypto = yield* Crypto.Crypto
  const directoryVisible = yield* fileSystem.stat(input.workspacePath).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.orElseSucceed(() => false),
  )
  const workspaceExists = directoryVisible || (input.workspaceVisible !== undefined && (yield* input.workspaceVisible))
  const gitExecutable = Bun.which("git")
  const browserExecutable = ["google-chrome", "chromium", "chromium-browser"]
    .map((name) => Bun.which(name))
    .find((path) => path !== null)
  const agentBrowserExecutable = Bun.which("agent-browser")
  const browserReady = input.browser ?? (browserExecutable !== undefined && agentBrowserExecutable !== null)
  const mcp = yield* inspectMcp(input)
  const states = {
    filesystem: workspaceExists
      ? ready("workspace filesystem available")
      : unavailable("workspace root is unavailable"),
    nativeTools: input.nativeTools ? ready("native tools available") : unavailable("native tools are unavailable"),
    git: gitExecutable === null ? unavailable("Git executable is unavailable") : ready("Git executable available"),
    process: ready("Bun process operations available"),
    pty: input.pty ? ready("durable PTY available") : unavailable("durable PTY is unavailable"),
    browser:
      browserReady && browserExecutable !== undefined && agentBrowserExecutable !== null
        ? ready("browser and agent-browser executables available")
        : unavailable("browser or agent-browser executable is unavailable"),
    services:
      input.services === true
        ? ready("supervised repository services available")
        : unavailable("supervised repository services are unavailable"),
    workspaceLifecycle: workspaceExists
      ? ready("workspace lifecycle ready")
      : unavailable("workspace lifecycle is not ready"),
    mcp,
  } as const
  const identity = encodeIdentity({
    target: input.target,
    workspacePath: input.workspacePath,
    bun: Bun.version,
    gitExecutable,
    browserExecutable: browserExecutable ?? null,
    agentBrowserExecutable,
    states,
  })
  const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(identity)).pipe(Effect.orDie)
  const capturedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
  return {
    environmentDigest: `sha256:${Encoding.encodeHex(digest)}`,
    capturedAt,
    ...states,
  } satisfies WorkspaceCapabilitySnapshot
})
