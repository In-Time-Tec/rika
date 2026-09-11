import { Clock, Crypto, Effect, Encoding, Redacted, Ref, Schema, Scope } from "effect"
import { sameBinding, type WorkspaceBinding } from "@rika/execution"
import { BoxId, WorkspaceEnrollmentError } from "@rika/box-executor"
import type { BoxBootstrapAuthority } from "@rika/box-executor/bootstrap"
import { samePartition, type ThreadExecutionBinding } from "../runtime/partition"
import { RunnerConnectionError, type RunnerConnectionAuthorization } from "./runner-connection"
import * as WorkspaceGateway from "./runner-gateway"

const maximumTickets = 256
const ticketLifetimeMillis = 60_000

export interface BoxEnrollmentTicket {
  readonly url: string
  readonly ticket: Redacted.Redacted<string>
  readonly expiresAtMillis: number
}

export interface BoxEnrollmentAuthority {
  readonly issue: (
    boxId: BoxId,
    binding: WorkspaceBinding,
  ) => Effect.Effect<BoxEnrollmentTicket, WorkspaceEnrollmentError>
  readonly authorize: (
    request: Request,
    boxId: string,
  ) => Effect.Effect<RunnerConnectionAuthorization, RunnerConnectionError>
  readonly validate: (boxId: BoxId, binding: WorkspaceBinding) => Effect.Effect<void, WorkspaceEnrollmentError>
}

export interface BoxEnrollmentAuthorityOptions {
  readonly publicUrl: string
  readonly crypto: Crypto.Crypto
  readonly current: (
    boxId: BoxId,
    binding: WorkspaceBinding,
  ) => Effect.Effect<ThreadExecutionBinding | undefined, WorkspaceEnrollmentError>
}

interface Grant {
  readonly boxId: BoxId
  readonly binding: ThreadExecutionBinding
  readonly expiresAtMillis: number
}

interface AuthorityState {
  readonly closed: boolean
  readonly grants: ReadonlyMap<string, Grant>
}

const rejected = () =>
  WorkspaceEnrollmentError.make({ phase: "enroll", message: "Box enrollment is unavailable for this assignment" })

const unauthorized = () =>
  RunnerConnectionError.make({ kind: "unauthorized", message: "A current Box enrollment ticket is required" })

const enrollmentOrigin = (input: string) =>
  Effect.try({
    try: () => {
      const url = new URL(input)
      if (
        (url.protocol !== "https:" &&
          !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) ||
        url.username !== "" ||
        url.password !== "" ||
        url.search !== "" ||
        url.hash !== "" ||
        (url.pathname !== "/" && url.pathname !== "")
      )
        throw new Error("Invalid enrollment origin")
      return url.origin
    },
    catch: rejected,
  })

export const boxExecutorPath = (boxId: string) => `/api/v2/boxes/${encodeURIComponent(boxId)}/executor`

export const boxExecutorRequestId = (request: Request) => {
  if (request.method !== "GET") return undefined
  const match = /^\/api\/v2\/boxes\/([^/]+)\/executor$/.exec(new URL(request.url).pathname)
  if (match?.[1] === undefined) return undefined
  try {
    return decodeURIComponent(match[1])
  } catch {
    return undefined
  }
}

export const makeBoxEnrollmentAuthority = Effect.fn("Rika.BoxEnrollment.make")(function* (
  options: BoxEnrollmentAuthorityOptions,
): Effect.fn.Return<BoxEnrollmentAuthority, WorkspaceEnrollmentError, Scope.Scope> {
  const origin = yield* enrollmentOrigin(options.publicUrl)
  const state = yield* Ref.make<AuthorityState>({ closed: false, grants: new Map() })
  yield* Effect.addFinalizer(() => Ref.set(state, { closed: true, grants: new Map() }))

  const digest = (ticket: string) =>
    options.crypto
      .digest("SHA-256", new TextEncoder().encode(ticket))
      .pipe(Effect.map(Encoding.encodeBase64Url), Effect.mapError(rejected))

  const current = (boxId: BoxId, expected: WorkspaceBinding) =>
    Effect.gen(function* () {
      if ((yield* Ref.get(state)).closed || expected.placement._tag !== "Orb") return yield* rejected()
      const binding = yield* options.current(boxId, expected)
      if (
        binding === undefined ||
        binding.partition.target !== "orb" ||
        !sameBinding(binding.workspaceBinding, expected)
      )
        return yield* rejected()
      return binding
    })

  const issue: BoxEnrollmentAuthority["issue"] = (boxId, expected) =>
    Effect.gen(function* () {
      yield* Schema.decodeEffect(BoxId)(boxId).pipe(Effect.mapError(rejected))
      const binding = yield* current(boxId, expected)
      const now = yield* Clock.currentTimeMillis
      const ticket = yield* options.crypto
        .randomBytes(32)
        .pipe(Effect.map(Encoding.encodeBase64Url), Effect.mapError(rejected))
      const key = yield* digest(ticket)
      const expiresAtMillis = now + ticketLifetimeMillis
      const accepted = yield* Ref.modify(state, (previous): readonly [boolean, AuthorityState] => {
        if (previous.closed) return [false, previous]
        const grants = new Map(
          [...previous.grants].filter(
            ([, grant]) =>
              grant.expiresAtMillis > now && grant.binding.workspaceBinding.assignmentId !== expected.assignmentId,
          ),
        )
        if (grants.size >= maximumTickets) return [false, previous]
        grants.set(key, { boxId, binding, expiresAtMillis })
        return [true, { closed: false, grants }]
      })
      if (!accepted) return yield* rejected()
      const url = new URL(boxExecutorPath(boxId), origin)
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
      return { url: url.href, ticket: Redacted.make(ticket), expiresAtMillis }
    })

  const authorize: BoxEnrollmentAuthority["authorize"] = (request, routingId) =>
    Effect.gen(function* () {
      const boxId = yield* Schema.decodeEffect(BoxId)(routingId).pipe(Effect.mapError(unauthorized))
      if (request.method !== "GET" || request.url !== `${origin}${boxExecutorPath(boxId)}`) return yield* unauthorized()
      const credential = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "")?.[1]
      if (credential === undefined) return yield* unauthorized()
      const key = yield* digest(credential).pipe(Effect.mapError(unauthorized))
      const now = yield* Clock.currentTimeMillis
      const grant = yield* Ref.modify(state, (previous): readonly [Grant | undefined, AuthorityState] => {
        const value = previous.grants.get(key)
        if (previous.closed || value === undefined || value.boxId !== boxId || value.expiresAtMillis <= now)
          return [undefined, previous]
        const grants = new Map(previous.grants)
        grants.delete(key)
        return [value, { ...previous, grants }]
      })
      if (grant === undefined) return yield* unauthorized()
      const validate = current(boxId, grant.binding.workspaceBinding).pipe(
        Effect.flatMap((binding) =>
          samePartition(binding.partition, grant.binding.partition) ? Effect.void : rejected(),
        ),
        Effect.mapError(() =>
          RunnerConnectionError.make({ kind: "forbidden", message: "Box assignment is no longer current" }),
        ),
      )
      yield* validate
      return { binding: grant.binding, validate }
    })

  return { issue, authorize, validate: (boxId, binding) => current(boxId, binding).pipe(Effect.asVoid) }
})

export const makeBoxGateway = Effect.fn("Rika.BoxGateway.make")(function* (options: BoxEnrollmentAuthorityOptions) {
  const authority = yield* makeBoxEnrollmentAuthority(options)
  const gateway = yield* WorkspaceGateway.makeWorkspaceGateway(authority.authorize)
  const enrollment: BoxBootstrapAuthority = {
    issue: authority.issue,
    ready: (boxId, binding) =>
      authority.validate(boxId, binding).pipe(
        Effect.andThen(gateway.ready(binding)),
        Effect.mapError(() =>
          WorkspaceEnrollmentError.make({ phase: "handshake", message: "Box enrollment readiness is unavailable" }),
        ),
      ),
  }
  return { gateway, enrollment }
})
