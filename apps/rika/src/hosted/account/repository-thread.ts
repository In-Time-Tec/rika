import { Console, Crypto, Effect } from "effect"
import type { ClientTicketResponse } from "@rika/product/client-protocol"
import type { RepositoryService } from "@rika/product/workspace-capability"
import { HostedError, Http, ThreadClient, type ThreadClientInterface } from "../contract"
import type { RunRequest } from "../contract"
import { prepareWorkspaceSeed } from "../workspace/seed"
import { authenticated, selectedProfile } from "./session"
import { accountSupport } from "./support"

const { failure, json, staleOwner, validOwner } = accountSupport

const threadControl = Effect.fn("HostedAccount.threadControl")(function* <A>(
  run: (input: {
    readonly ticket: ClientTicketResponse
    readonly threads: ThreadClientInterface
    readonly operationId: string
  }) => Effect.Effect<A, HostedError>,
) {
  const profile = yield* selectedProfile()
  const http = yield* Http
  const threads = yield* ThreadClient
  const crypto = yield* Crypto.Crypto
  const operationId = yield* crypto.randomUUIDv4.pipe(
    Effect.mapError(() => failure("host", "Could not create an operation identifier")),
  )
  return yield* authenticated(profile, (session) =>
    http
      .issueThreadTicket(profile.origin, session)
      .pipe(Effect.flatMap((ticket) => run({ ticket, threads, operationId }))),
  )
})

export const ensureRepositoryService = Effect.fn("HostedAccount.ensureRepositoryService")(function* (
  threadId: string,
  service: RepositoryService,
) {
  yield* threadControl(({ ticket, threads, operationId }) =>
    threads.ensureService({ ticket, threadId, commandId: operationId, service }),
  )
  yield* Console.log(`Repository service ${service.serviceId} is running`)
})

export const stopRepositoryService = Effect.fn("HostedAccount.stopRepositoryService")(function* (
  threadId: string,
  serviceId: string,
) {
  yield* threadControl(({ ticket, threads, operationId }) =>
    threads.stopService({ ticket, threadId, commandId: operationId, serviceId }),
  )
  yield* Console.log(`Repository service ${serviceId} is stopped`)
})

export const openThreadPortal = Effect.fn("HostedAccount.openThreadPortal")(function* (threadId: string, port: number) {
  const url = yield* threadControl(({ ticket, threads, operationId }) =>
    threads.openPortal({ ticket, threadId, requestId: operationId, port }),
  )
  yield* Console.log(url)
})

export const inspectRecovery = Effect.fn("HostedAccount.inspectRecovery")(function* (threadId: string, runId: string) {
  const profile = yield* selectedProfile()
  const http = yield* Http
  const operations = yield* authenticated(profile, (session) =>
    http.inspectRecovery(profile.origin, threadId, runId, session),
  )
  yield* Console.log(yield* json(operations))
})

export const resolveRecovery = Effect.fn("HostedAccount.resolveRecovery")(function* (
  threadId: string,
  runId: string,
  operationId: string,
  resolution:
    | { readonly action: "retry" }
    | { readonly action: "accept"; readonly value: unknown }
    | { readonly action: "abort"; readonly reason: string },
) {
  const profile = yield* selectedProfile()
  const http = yield* Http
  const crypto = yield* Crypto.Crypto
  const operationKey = yield* crypto.randomUUIDv4.pipe(
    Effect.mapError(() => failure("host", "Could not create a recovery resolution identifier")),
  )
  const operation = yield* authenticated(profile, (session) =>
    http.resolveRecovery(profile.origin, threadId, runId, operationId, resolution, operationKey, session),
  )
  yield* Console.log(yield* json(operation))
})

export const syncRepository = Effect.fn("HostedAccount.syncRepository")(function* (input: {
  readonly threadId: string
  readonly commitSha: string
  readonly targetBranch?: string | undefined
  readonly title: string
  readonly body: string
}) {
  const profile = yield* selectedProfile()
  const http = yield* Http
  const crypto = yield* Crypto.Crypto
  const operationId = yield* crypto.randomUUIDv4.pipe(
    Effect.mapError(() => failure("host", "Could not create a repository synchronization identifier")),
  )
  const publication = yield* authenticated(profile, (session) =>
    http.publishRepository(
      profile.origin,
      input.threadId,
      input.commitSha,
      input.targetBranch,
      input.title,
      input.body,
      operationId,
      session,
    ),
  )
  yield* Console.log(
    `Repository synchronization ${publication.state}: ${publication.ref} -> ${publication.targetBranch}`,
  )
})

export const createRemoteThread = Effect.fn("HostedAccount.createRemoteThread")(function* (
  workspace: string = process.cwd(),
) {
  const profile = yield* selectedProfile()
  const http = yield* Http
  const threads = yield* ThreadClient
  const crypto = yield* Crypto.Crypto
  const commandId = yield* crypto.randomUUIDv4.pipe(
    Effect.mapError(() => failure("host", "Could not create a Thread identifier")),
  )
  const workspaceSeed = yield* Effect.scoped(prepareWorkspaceSeed(workspace))
  const threadId = yield* authenticated(profile, (session) =>
    http.context(profile.origin, session).pipe(
      Effect.filterOrFail((identity) => validOwner(profile, identity), staleOwner),
      Effect.andThen(
        Effect.all({
          seed: http.uploadWorkspaceSeed(
            profile.origin,
            workspaceSeed.archive,
            workspaceSeed.sourceRepository,
            session,
          ),
          ticket: http.issueThreadTicket(profile.origin, session),
        }),
      ),
      Effect.flatMap(({ seed, ticket }) => {
        const request = {
          ticket,
          commandId,
          owner: profile.owner,
          executorKind: "orb",
          workspaceSeedId: seed.id,
        } satisfies Parameters<typeof threads.create>[0]
        return threads.create(
          Object.assign(request, profile.project === undefined ? undefined : { project: profile.project }),
        )
      }),
    ),
  )
  yield* Console.log(`Created Orb Thread ${threadId}`)
})

export const runThread = Effect.fn("HostedAccount.runThread")(function* (threadId: string, request: RunRequest) {
  const profile = yield* selectedProfile()
  const crypto = yield* Crypto.Crypto
  const http = yield* Http
  const threads = yield* ThreadClient
  const key = yield* crypto.randomUUIDv4.pipe(
    Effect.mapError(() => failure("host", "Could not create an operation identifier")),
  )
  const result = yield* authenticated(profile, (session) =>
    http
      .issueThreadTicket(profile.origin, session)
      .pipe(Effect.flatMap((ticket) => threads.submit({ ticket, threadId, request, commandId: key }))),
  )
  yield* Console.log(`Queued command ${result.commandId}`)
})
