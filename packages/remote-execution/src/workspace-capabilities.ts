import { WorkspaceCapability, type WorkspaceCapabilitySnapshot } from "@rika/product/executor-assignment"
import { Clock, Crypto, DateTime, Effect, Encoding, FileSystem, Schema } from "effect"

const ready = (detail: string): WorkspaceCapability => ({ _tag: "Ready", detail })
const unavailable = (reason: string): WorkspaceCapability => ({ _tag: "Unavailable", reason })
const encodeIdentity = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      target: Schema.Literals(["local_device", "e2b"]),
      workspacePath: Schema.String,
      bun: Schema.String,
      gitExecutable: Schema.NullOr(Schema.String),
      browserExecutable: Schema.NullOr(Schema.String),
      states: Schema.Struct({
        filesystem: WorkspaceCapability,
        typescriptKernel: WorkspaceCapability,
        git: WorkspaceCapability,
        process: WorkspaceCapability,
        pty: WorkspaceCapability,
        browser: WorkspaceCapability,
        workspaceLifecycle: WorkspaceCapability,
      }),
    }),
  ),
)

export const inspectWorkspaceCapabilities = Effect.fn("WorkspaceCapabilities.inspect")(function* (input: {
  readonly target: "local_device" | "e2b"
  readonly workspacePath: string
  readonly typescriptKernel: boolean
  readonly pty: boolean
}) {
  const fileSystem = yield* FileSystem.FileSystem
  const crypto = yield* Crypto.Crypto
  const workspaceExists = yield* fileSystem.exists(input.workspacePath).pipe(Effect.orElseSucceed(() => false))
  const gitExecutable = Bun.which("git")
  const browserExecutable = ["google-chrome", "chromium", "chromium-browser"]
    .map((name) => Bun.which(name))
    .find((path) => path !== null)
  const states = {
    filesystem: workspaceExists
      ? ready("workspace filesystem available")
      : unavailable("workspace root is unavailable"),
    typescriptKernel: input.typescriptKernel
      ? ready("persistent Bun TypeScript kernel available")
      : unavailable("TypeScript kernel is unavailable"),
    git: gitExecutable === null ? unavailable("Git executable is unavailable") : ready("Git executable available"),
    process: ready("Bun process operations available"),
    pty: input.pty ? ready("durable PTY available") : unavailable("durable PTY is unavailable"),
    browser:
      browserExecutable === undefined
        ? unavailable("browser executable is unavailable")
        : ready("browser executable available"),
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
