import { HandshakeEvidence, WorkspaceBinding } from "@rika/execution"
import { Clock, Effect, Redacted, Schema } from "effect"

import { boxBootstrapPaths, makeBoxWorkspaceEnrollment, type BoxBootstrapAuthority } from "../../src/bootstrap"
import { BoxId } from "../../src/contract"
import { BoxTransportError, type BoxTransport } from "../../src/provider"

const FileWriteRequest = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
  encoding: Schema.Literal("utf8"),
})
const BootstrapState = Schema.Struct({
  version: Schema.Literal(1),
  phase: Schema.Literals(["prepared", "starting", "failed"]),
  binding: WorkspaceBinding,
  workspacePath: Schema.String,
})
const CommandRequest = Schema.Struct({ command: Schema.String, detached: Schema.Literal(true) })

export const boxId = Schema.decodeSync(BoxId)("bx_23456789")
export const binding = Schema.decodeSync(WorkspaceBinding)({
  workspaceId: "workspace-box-1",
  assignmentId: "assignment-box-1",
  generation: 3,
  placement: { _tag: "Orb", workspaceId: "workspace-box-1", lineageId: "lineage-box-1" },
  buildId: "runner-build-1",
  protocolVersion: 1,
})
export const changedBinding = Schema.decodeSync(WorkspaceBinding)({
  ...binding,
  assignmentId: "assignment-box-2",
  generation: 4,
})
export const paths = boxBootstrapPaths(binding)
export const changedPaths = boxBootstrapPaths(changedBinding)
export const workspacePath = "/home/user/workspace"
export const fleetCredential = "fleet-provider-secret"
export const enrollmentTicket = "scoped-box-enrollment-ticket"

export const response = (body: Schema.Json, status = 200) =>
  Response.json(body, { status, headers: { "content-type": "application/json" } })

const missing = () =>
  response(
    {
      ok: false,
      type: "box.error",
      status: 404,
      code: "not_found",
      message: "Not found",
      error: { code: "not_found", message: "Not found", status: 404 },
      requestId: "req_missing",
    },
    404,
  )

const decodeRequest = <A, I>(request: Request, schema: Schema.Codec<A, I, never, never>) =>
  Effect.tryPromise({
    try: () => request.text(),
    catch: () => BoxTransportError.make({ message: "Test request body was invalid" }),
  }).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(schema))),
    Effect.mapError(() => BoxTransportError.make({ message: "Test request body was invalid" })),
  )

interface CapturedRequest {
  readonly method: string
  readonly url: string
  readonly authorization: string | null
  readonly contentType: string | null
  readonly body: string
}

export const makeTransport = (
  startOutcome: "started" | "lost-after-start" | "lock-contended" = "started",
  activeBinding = binding,
) => {
  const activePaths = boxBootstrapPaths(activeBinding)
  const files = new Map<string, string>()
  const requests: Array<CapturedRequest> = []
  const commands: Array<string> = []
  const transport: BoxTransport = {
    request: (request) =>
      Effect.gen(function* () {
        const body = request.method === "GET" ? "" : yield* Effect.tryPromise(() => request.clone().text())
        requests.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.get("authorization"),
          contentType: request.headers.get("content-type"),
          body,
        })
        const url = new URL(request.url)
        if (request.method === "GET" && url.pathname.endsWith("/files")) {
          const path = url.searchParams.get("path")
          if (path === null) return missing()
          const content = files.get(path)
          if (content === undefined) return missing()
          return response({
            ok: true,
            type: "file.read",
            success: true,
            path,
            encoding: "utf8",
            size: new TextEncoder().encode(content).byteLength,
            content,
          })
        }
        if (request.method === "PUT" && url.pathname.endsWith("/files")) {
          const file = yield* decodeRequest(request, FileWriteRequest)
          files.set(file.path, file.content)
          return response({
            ok: true,
            type: "file.written",
            success: true,
            path: file.path,
            encoding: file.encoding,
            size: new TextEncoder().encode(file.content).byteLength,
          })
        }
        if (request.method === "POST" && url.pathname.endsWith("/commands")) {
          const command = yield* decodeRequest(request, CommandRequest)
          commands.push(command.command)
          const prepared = files.get(activePaths.statePath)
          if (prepared !== undefined && startOutcome !== "lock-contended") {
            const state = yield* Schema.decodeEffect(Schema.fromJsonString(BootstrapState))(prepared)
            const starting = yield* Schema.encodeEffect(Schema.fromJsonString(BootstrapState))({
              ...state,
              phase: "starting",
            })
            files.set(activePaths.statePath, starting)
          }
          if (startOutcome === "lost-after-start")
            return yield* BoxTransportError.make({ message: "Start acknowledgement was lost" })
          return response({
            ok: true,
            type: "command.started",
            success: true,
            processId: 71,
            pid: 72,
            command: command.command,
            startedAt: "2026-09-10T12:00:00.000Z",
          })
        }
        return response({ ok: false }, 400)
      }).pipe(
        Effect.mapError((error) =>
          Schema.is(BoxTransportError)(error)
            ? error
            : BoxTransportError.make({ message: "Test Box transport failed" }),
        ),
      ),
  }
  return { commands, files, requests, transport }
}

export const makeAuthority = (readyValues: ReadonlyArray<HandshakeEvidence | undefined> = []) => {
  let issues = 0
  let checks = 0
  const values = [...readyValues]
  const authority: BoxBootstrapAuthority = {
    issue: () =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          issues += 1
          return {
            url: `wss://rika.test/api/v2/boxes/${boxId}/executor`,
            ticket: Redacted.make(enrollmentTicket, { label: "box-enrollment" }),
            expiresAtMillis: now + 60_000,
          }
        }),
      ),
    ready: () =>
      Effect.sync(() => {
        const value = values[checks]
        checks += 1
        return value
      }),
  }
  return { authority, checks: () => checks, issues: () => issues }
}

export const makeService = (
  transport: BoxTransport,
  authority: BoxBootstrapAuthority,
  options: { readonly readinessAttempts?: number; readonly requestTimeoutMillis?: number } = {},
) =>
  makeBoxWorkspaceEnrollment({
    baseUrl: "https://ascii.test/api/box/v1",
    apiKey: Redacted.make(fleetCredential, { label: "box-fleet" }),
    transport,
    authority,
    runner: {
      buildId: binding.buildId,
      command: ["/opt/rika/bin/runner-v2", "box", "--bootstrap-stdin"],
    },
    workspacePath,
    readinessAttempts: options.readinessAttempts ?? 3,
    readinessDelayMillis: 0,
    requestTimeoutMillis: options.requestTimeoutMillis ?? 1_000,
  })

export const stateFor = (phase: "prepared" | "starting" | "failed", current = binding) =>
  Schema.encodeSync(Schema.fromJsonString(BootstrapState))({ version: 1, phase, binding: current, workspacePath })
