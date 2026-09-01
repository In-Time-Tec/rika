import { WorkspaceCapability, type WorkspaceCapabilitySnapshot } from "@rika/product/executor-assignment"
import { Clock, Crypto, DateTime, Effect, Encoding, FileSystem, Schema } from "effect"

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
      }),
    }),
  ),
)

export const inspectWorkspaceCapabilities = Effect.fn("WorkspaceCapabilities.inspect")(function* (input: {
  readonly target: "runner" | "orb"
  readonly workspacePath: string
  readonly nativeTools: boolean
  readonly pty: boolean
  readonly browser?: boolean
  readonly services?: boolean
}) {
  const fileSystem = yield* FileSystem.FileSystem
  const crypto = yield* Crypto.Crypto
  const workspaceExists = yield* fileSystem.stat(input.workspacePath).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.orElseSucceed(() => false),
  )
  const gitExecutable = Bun.which("git")
  const browserExecutable = ["google-chrome", "chromium", "chromium-browser"]
    .map((name) => Bun.which(name))
    .find((path) => path !== null)
  const agentBrowserExecutable = Bun.which("agent-browser")
  const browserReady = input.browser ?? (browserExecutable !== undefined && agentBrowserExecutable !== null)
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
