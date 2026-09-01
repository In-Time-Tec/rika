import { ApiMessage, RunnerMessage, type AccessWire } from "@rika/remote-execution/protocol"
import { Config, Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import type { Socket } from "../../../src/executor/gateway"
import type { RunnerExecutorAuthority } from "../../../src/runner/executor"
import { makeRunnerGateway as makeRunnerGatewayService } from "../../../src/runner/gateway"

export const makeRunnerGateway: (authority: RunnerExecutorAuthority) => ReturnType<typeof makeRunnerGatewayService> =
  makeRunnerGatewayService

export const databaseUrl = Effect.runSync(
  Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL").pipe(Config.withDefault("")),
)
export const live = databaseUrl !== ""
export const encode = Schema.encodeSync(Schema.fromJsonString(RunnerMessage))
export const decode = Schema.decodeSync(Schema.fromJsonString(ApiMessage))
export const nativeCode = JSON.stringify({ toolName: "read", request: { _tag: "Read", path: "README.md" } })
export const sessionToken = "session-local-gateway"
export const sessionDigest = createHash("sha256").update(sessionToken).digest("hex")
export const deviceId = "11111111-1111-4111-8111-111111111111"
export const assignmentId = "assignment-local-gateway"
export const threadId = "thread-local-gateway"
export const toolRequest = (operationKey: string, deadlineAt = "2999-01-01T00:00:00.000Z") => ({
  assignmentId,
  operationKey,
  workspaceId: "workspace-local-gateway",
  sessionId: assignmentId,
  threadId,
  turnId: "turn-local-gateway",
  runId: "run-local-gateway",
  rootRunId: "run-local-gateway",
  toolCallId: "call-local-gateway",
  code: nativeCode,
  attempt: 0,
  replayPolicy: "pure" as const,
  admittedAt: null,
  deadlineAt,
  machineRequest: { _tag: "NativeTool" as const, request: { _tag: "Read" as const, path: "README.md" } },
})
type OperationDigestInput = Pick<
  ReturnType<typeof toolRequest>,
  | "workspaceId"
  | "sessionId"
  | "threadId"
  | "turnId"
  | "runId"
  | "rootRunId"
  | "toolCallId"
  | "code"
  | "attempt"
  | "replayPolicy"
>
export const operationDigest = (request: OperationDigestInput) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        threadId: request.threadId,
        turnId: request.turnId,
        runId: request.runId,
        rootRunId: request.rootRunId,
        toolCallId: request.toolCallId,
        code: request.code,
        attempt: request.attempt,
        replayPolicy: request.replayPolicy,
      }),
    )
    .digest("hex")

export const access: AccessWire = {
  version: 1,
  fence: {
    target: "runner",
    assignmentId,
    assignmentGeneration: 1,
    instanceId: deviceId,
    executorId: "executor-local-gateway",
    processIncarnation: "process-local-gateway",
  },
  leaseEpoch: 1,
  sessionToken,
}

export const response = {
  _tag: "Success" as const,
  result: { text: "native result", truncated: false },
}
export const cancelledResponse = {
  _tag: "DomainFailure" as const,
  failure: { kind: "cancelled" as const, message: "Tool operation cancelled" },
}
export const environmentDigest = `sha256:${"0".repeat(64)}`
export const workspaceCapabilities = {
  environmentDigest,
  capturedAt: "2026-08-21T00:00:00.000Z",
  filesystem: { _tag: "Ready", detail: "filesystem ready" },
  nativeTools: { _tag: "Ready", detail: "TypeScript runtime ready" },
  git: { _tag: "Ready", detail: "Git ready" },
  process: { _tag: "Ready", detail: "process ready" },
  pty: { _tag: "Ready", detail: "PTY ready" },
  browser: { _tag: "Ready", detail: "browser ready" },
  services: { _tag: "Unavailable", reason: "repository services unavailable" },
  workspaceLifecycle: { _tag: "Ready", detail: "workspace lifecycle ready" },
}

export const socket = (): Socket & {
  failSend: boolean
  readonly sent: Array<string>
  readonly closed: Array<readonly [number | undefined, string | undefined]>
} => {
  const sent: Array<string> = []
  const closed: Array<readonly [number | undefined, string | undefined]> = []
  return {
    failSend: false,
    sent,
    closed,
    send(message: string) {
      sent.push(message)
      if (this.failSend) throw new Error("test delivery stop")
    },
    close: (status?: number, reason?: string) => closed.push([status, reason]),
  }
}

export const authority = (input?: {
  readonly renewedLeaseEpoch?: number
  readonly release?: RunnerExecutorAuthority["release"]
  readonly validateAccess?: RunnerExecutorAuthority["validateAccess"]
}): RunnerExecutorAuthority => ({
  admit: () => Effect.die("unused"),
  hello: () => Effect.die("unused"),
  reconnect: (presented) =>
    Effect.succeed({
      version: 1,
      fence: presented.fence,
      leaseEpoch: input?.renewedLeaseEpoch ?? presented.leaseEpoch,
      leaseExpiresAt: 4_102_444_800_000,
      heartbeatIntervalMillis: 20_000,
      cursor: { sequence: 0, value: "" },
    }),
  validateAccess: input?.validateAccess ?? (() => Effect.void),
  workspaceIdentity: () => Effect.succeed("workspace-local-gateway"),
  heartbeat: () => Effect.die("unused"),
  release: input?.release ?? (() => Effect.void),
})
