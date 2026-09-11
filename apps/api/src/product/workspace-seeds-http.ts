import { BetterAuthUserId, OrganizationId, type HostedOwner } from "@rika/product/hosted-model"
import { MaximumArchiveBytes } from "@rika/workspace-input/contract"
import {
  WorkspaceSeedStageRequest,
  type WorkspaceSeedStageReceipt,
  type WorkspaceSeedStageRequest as WorkspaceSeedStageRequestValue,
} from "@rika/workspace-input/workspace-seed-http-contract"
import { Effect, Schema } from "effect"
import { authenticateIdentityRequest, type IdentityHttpOptions, type IdentityRequestAccess } from "../identity/http"
import type { WorkspaceSeedActor, WorkspaceSeedService, WorkspaceSeedServiceError } from "./workspace-seeds"

export interface WorkspaceSeedsHttpOptions extends IdentityHttpOptions {
  readonly workspaceSeeds: WorkspaceSeedService
}

export type WorkspaceSeedsRequestHandler = (request: Request) => Effect.Effect<Response | undefined, never>

class WorkspaceSeedsHttpError extends Schema.TaggedError<WorkspaceSeedsHttpError>()("RikaWorkspaceSeedsHttpError", {
  status: Schema.Int,
  message: Schema.String,
}) {}

const encodedArchiveMaximum = Math.ceil(MaximumArchiveBytes / 3) * 4
export const MaximumWorkspaceSeedRequestBytes = encodedArchiveMaximum + 8 * 1024

const httpFailure = (status: number, message: string) => WorkspaceSeedsHttpError.make({ status, message })
const invalid = () => httpFailure(400, "Invalid workspace seed request")
const unauthorized = () => httpFailure(401, "CLI device authentication required")

const serviceStatus = {
  invalid: 400,
  forbidden: 403,
  "not-found": 404,
  conflict: 409,
  unavailable: 503,
} as const
const serviceFailure = (error: WorkspaceSeedServiceError) => httpFailure(serviceStatus[error.kind], error.message)

const json = <A>(value: A, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  })

const errorResponse = (error: WorkspaceSeedsHttpError) => {
  const response = json({ message: error.message }, error.status)
  if (error.status === 401) response.headers.set("www-authenticate", 'Bearer realm="rika"')
  return response
}

const readBody = (body: ReadableStream<Uint8Array> | null, contentLength: string | null) => {
  let completed = false
  return Effect.acquireUseRelease(
    Effect.try({ try: () => body?.getReader(), catch: invalid }),
    (reader) =>
      Effect.gen(function* () {
        if (contentLength !== null) {
          if (!/^(?:0|[1-9][0-9]*)$/.test(contentLength)) return yield* invalid()
          const declared = Number(contentLength)
          if (!Number.isSafeInteger(declared)) return yield* invalid()
          if (declared > MaximumWorkspaceSeedRequestBytes) return yield* httpFailure(413, "Request body is too large")
        }
        if (reader === undefined) return ""
        const chunks: Uint8Array[] = []
        let total = 0
        while (true) {
          const next = yield* Effect.tryPromise({ try: () => reader.read(), catch: invalid })
          if (next.done) {
            completed = true
            if (contentLength !== null && total !== Number(contentLength)) return yield* invalid()
            const bytes = new Uint8Array(total)
            let offset = 0
            for (const chunk of chunks) {
              bytes.set(chunk, offset)
              offset += chunk.byteLength
            }
            return yield* Effect.try({
              try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
              catch: invalid,
            })
          }
          if (total > MaximumWorkspaceSeedRequestBytes - next.value.byteLength)
            return yield* httpFailure(413, "Request body is too large")
          chunks.push(next.value)
          total += next.value.byteLength
        }
      }).pipe(
        Effect.timeout("30 seconds"),
        Effect.catchTag("TimeoutError", () => invalid()),
      ),
    (reader) => {
      if (reader === undefined) return Effect.void
      const cancel = completed
        ? Effect.void
        : Effect.tryPromise({ try: () => reader.cancel(), catch: invalid }).pipe(
            Effect.timeout("100 millis"),
            Effect.ignore,
          )
      return cancel.pipe(
        Effect.andThen(Effect.try({ try: () => reader.releaseLock(), catch: invalid }).pipe(Effect.ignore)),
      )
    },
  )
}

const actorFor = (access: IdentityRequestAccess): Effect.Effect<WorkspaceSeedActor, WorkspaceSeedsHttpError> => {
  if (access.deviceId === undefined || access.principal.clientId === undefined) return unauthorized()
  return Effect.succeed({
    userId: access.principal.userId,
    clientId: access.principal.clientId,
    deviceId: access.deviceId,
  })
}

const ownerFor = (actor: WorkspaceSeedActor, owner: WorkspaceSeedStageRequestValue["owner"]): HostedOwner =>
  owner.kind === "personal"
    ? { _tag: "PersonalOwner", userId: BetterAuthUserId.make(actor.userId) }
    : { _tag: "OrganizationOwner", organizationId: OrganizationId.make(owner.organization_id) }

const stageWorkspaceSeed = Effect.fn("RikaApiV2.WorkspaceSeedsHttp.stage")(function* (
  request: Request,
  options: WorkspaceSeedsHttpOptions,
) {
  const access = yield* authenticateIdentityRequest(request, options).pipe(
    Effect.mapError((error) =>
      error.kind === "unavailable" ? httpFailure(503, "Identity service unavailable") : unauthorized(),
    ),
  )
  const actor = yield* actorFor(access)
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers.get("content-type") ?? "")) return yield* invalid()
  const text = yield* readBody(request.body, request.headers.get("content-length"))
  const body = yield* Schema.decodeEffect(Schema.fromJsonString(WorkspaceSeedStageRequest))(text).pipe(
    Effect.mapError(invalid),
  )
  const input: Parameters<WorkspaceSeedService["stage"]>[0] = {
    actor,
    owner: ownerFor(actor, body.owner),
    archive: body.archive,
  }
  if (body.projectId !== undefined) Object.assign(input, { projectId: body.projectId })
  const receipt: WorkspaceSeedStageReceipt = yield* options.workspaceSeeds
    .stage(input)
    .pipe(Effect.mapError(serviceFailure))
  return json(receipt, 201)
})

export const makeWorkspaceSeedsRequestHandler =
  (options: WorkspaceSeedsHttpOptions): WorkspaceSeedsRequestHandler =>
  (request) => {
    const url = new URL(request.url)
    if (request.method !== "POST" || url.pathname !== "/api/v2/workspace-seeds")
      return Effect.void.pipe(Effect.as<Response | undefined>(undefined))
    return stageWorkspaceSeed(request, options).pipe(
      Effect.catchTag("RikaWorkspaceSeedsHttpError", (error) => Effect.succeed(errorResponse(error))),
    )
  }
