/* oxlint-disable typescript/no-unsafe-type-assertion -- this fixture isolates the released Server/client wire contract behind a tiny host. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the fixture host intentionally narrows a minimal handler surface. */
/* oxlint-disable effecttsgo/async-function -- the Web Request bridge is an explicit test transport boundary. */
/* oxlint-disable effecttsgo/lazy-promise-in-effect-sync -- handler disposal is a test-scope finalizer. */
/* oxlint-disable effecttsgo/unnecessary-effect-gen -- client construction stays in the fixture's Effect API. */
import { expect, it } from "@effect/vitest"
import { Config, Effect, Layer, Redacted } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServer from "effect/unstable/http/HttpServer"
import { Prompt } from "effect/unstable/ai"
import { ExecutableManifest } from "generalist"
import type { SessionFamilyPage } from "generalist/host"
import * as Runtime from "generalist/runtime"
import { Server } from "generalist/server"
import { makeGeneralistClient, type ExecutionClient } from "../src/generalist"

interface FixturePending {
  readonly id: string
  readonly revision: number
  readonly prompt: Prompt.Prompt
  readonly selection: {
    readonly executableRef: typeof executable.ref
    readonly executableManifest: typeof executable.manifest
    readonly registrations: readonly []
  }
}

const executable = ExecutableManifest.makeTest("client-v2-server")("agent")

interface FixtureSession {
  readonly id: string
  readonly title: string
  readonly createdAt: string
  readonly queue: readonly FixturePending[]
  readonly selection: FixturePending["selection"]
}

const makeFixture = (familyPage: SessionFamilyPage = { rootSessionId: "session", at: 0, sessions: [], nextBefore: null }) => {
  let session: FixtureSession = {
    id: "session",
    title: "Server fixture",
    createdAt: "2026-09-09T00:00:00.000Z",
    queue: [],
    selection: {
      executableRef: executable.ref,
      executableManifest: executable.manifest,
      registrations: [] as const,
    },
  }
  let sequence = 0
  const snapshot = () => ({
    version: 1 as const,
    session,
    cursor: 0,
    runs: [],
    conversation: { leafId: null, entries: [] },
  })
  const receipt = (id: string, revision: number) => Effect.succeed({ id, revision })
  const conflict = (hint: string) =>
    Runtime.SessionQueue.SessionQueueConflict.make({
      sessionId: session.id,
      reason: "revision",
      hint,
    })
  const handle = {
    inspect: Effect.sync(() => session),
    submit: (input: Prompt.Prompt | string) =>
      Effect.sync(() => {
        sequence += 1
        const id = `pending-${sequence}`
        const pending: FixturePending = {
          id,
          revision: 1,
          prompt: Prompt.make(input),
          selection: session.selection,
        }
        session = { ...session, queue: [...session.queue, pending] }
        return { id, revision: pending.revision }
      }),
    stop: () => Effect.void,
    close: () => Effect.void,
    resume: () => Effect.void,
    snapshot: Effect.sync(snapshot),
    queue: {
      list: () => Effect.sync(() => session.queue),
      update: (id: string, input: Prompt.Prompt | string, options: { readonly expectedRevision: number }) =>
        Effect.suspend(() => {
          const pending = session.queue.find((candidate) => candidate.id === id)
          if (pending === undefined || pending.revision !== options.expectedRevision)
            return Effect.fail(conflict("Pending input was promoted before this edit committed"))
          const next = { ...pending, revision: pending.revision + 1, prompt: Prompt.make(input) }
          session = { ...session, queue: session.queue.map((candidate) => (candidate.id === id ? next : candidate)) }
          return receipt(id, next.revision)
        }),
      remove: (id: string, options: { readonly expectedRevision: number }) =>
        Effect.suspend(() => {
          const pending = session.queue.find((candidate) => candidate.id === id)
          if (pending === undefined || pending.revision !== options.expectedRevision)
            return Effect.fail(conflict("Pending input was promoted before this removal committed"))
          session = { ...session, queue: session.queue.filter((candidate) => candidate.id !== id) }
          return receipt(id, pending.revision + 1)
        }),
    },
  }
  const host = {
    revision: "client-v2-server",
    sessions: {
      create: () => Effect.succeed(handle),
      get: () => Effect.succeed(handle),
      list: Effect.sync(() => [session]),
      snapshot: (sessionId: string) =>
        sessionId === session.id ? Effect.succeed(snapshot()) : Effect.die("missing session"),
      history: () => Effect.succeed({ leafId: null, entries: [], nextLeafId: null }),
      runs: () => Effect.succeed({ at: 0, runs: [], nextBefore: null }),
      run: () => Effect.die("run endpoint is not used by this fixture"),
      family: () => Effect.succeed({ ...familyPage, rootSessionId: session.id }),
      entry: () => Effect.die("entry endpoint is not used by this fixture"),
    },
    runs: {},
    tools: {},
    events: { subscribe: () => Effect.succeed({}) },
    attachments: {},
    artifacts: {},
    approvals: {},
    operator: {},
  }
  const serverAuth = Server.authBearer({
    token: Config.succeed(Redacted.make("client-v2-token")),
    principal: { id: "user", tenantId: "tenant", role: "controller" },
  })
  const layer = Server.layer({
    host: host as never,
    auth: serverAuth,
    authorization: { tenantId: "tenant", authorize: () => Effect.succeed(true) },
  }).pipe(Layer.provide(HttpServer.layerServices))
  const web = HttpRouter.toWebHandler(layer, { disableLogger: true })
  const seen: HttpClientRequest.HttpClientRequest[] = []
  const transport = HttpClient.make((request, _url, signal) =>
    Effect.sync(() => {
      seen.push(request)
    }).pipe(
      Effect.andThen(HttpClientRequest.toWeb(request, { signal })),
      Effect.orDie,
      Effect.flatMap((webRequest) =>
        // ast-grep-ignore: effect-prefer-promise-composition -- HttpRouter's Web handler is a foreign Promise boundary.
        Effect.promise(() => web.handler(webRequest)),
      ),
      Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
    ),
  )
  const authenticated = HttpClient.mapRequest(transport, (request) =>
    HttpClientRequest.setHeader(request, "authorization", "Bearer client-v2-token"),
  )
  const makeClient = (httpClient = authenticated) =>
    makeGeneralistClient({ baseUrl: "http://client-v2-server" }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
    )
  return { makeClient, snapshot, seen, transport, dispose: web.dispose }
}

it.effect("converges two released Generalist clients and preserves queue conflict identity", () => {
  const fixture = makeFixture()
  return Effect.scoped(
    Effect.gen(function* () {
      const clientA = yield* fixture.makeClient()
      const clientB = yield* fixture.makeClient()
      const initialA = yield* clientA.sessions.snapshot({ sessionId: "session" })
      const initialB = yield* clientB.sessions.snapshot({ sessionId: "session" })
      expect(initialA).toEqual(initialB)
      const submitted = yield* clientA.sessions.submit({ sessionId: "session", commandId: "submit-a", input: "queued" })
      const queuedB = yield* clientB.sessions.snapshot({ sessionId: "session" })
      const pending = queuedB.session.queue.find((candidate) => candidate.id === submitted.id)
      expect(pending?.revision).toBe(submitted.revision)
      const edited = yield* clientA.sessions.updateInput({
        sessionId: "session",
        id: submitted.id,
        commandId: "edit-a",
        expectedRevision: submitted.revision,
        input: "edited",
      })
      expect(edited.revision).toBe(submitted.revision + 1)
      const stale = yield* Effect.result(
        clientB.sessions.updateInput({
          sessionId: "session",
          id: submitted.id,
          commandId: "edit-b",
          expectedRevision: submitted.revision,
          input: "stale",
        }),
      )
      expect(stale._tag).toBe("Failure")
      if (stale._tag === "Failure") {
        expect(stale.failure._tag).toBe("generalist/session/SessionQueueConflict")
        expect("reason" in stale.failure ? stale.failure.reason : undefined).toBe("revision")
      }
      const finalA = yield* clientA.sessions.snapshot({ sessionId: "session" })
      const finalB = yield* clientB.sessions.snapshot({ sessionId: "session" })
      expect(finalA).toEqual(finalB)
      expect(finalA.session.queue[0]?.revision).toBe(edited.revision)
    }).pipe(Effect.ensuring(Effect.sync(fixture.dispose))),
  )
})

it.effect("exposes the released client through the execution adapter", () => {
  const fixture = makeFixture()
  return Effect.scoped(
    Effect.gen(function* () {
      const client = yield* fixture.makeClient()
      const execution = {
        raw: client,
        snapshot: client.sessions.snapshot,
        history: client.sessions.history,
        family: client.sessions.family,
        submit: client.sessions.submit,
        updateInput: client.sessions.updateInput,
        removeInput: client.sessions.removeInput,
        steer: client.runs.message,
        cancel: client.runs.cancel,
        control: client.sessions.control,
        runs: client.sessions.runs,
        connect: client.events.connect,
        subscribe: client.events.subscribe,
      } satisfies ExecutionClient
      const receipt = yield* execution.submit({ sessionId: "session", commandId: "adapter", input: "through adapter" })
      expect(receipt.id).toBe("pending-1")
    }).pipe(Effect.ensuring(Effect.sync(fixture.dispose))),
  )
})

it.effect("decodes a retained child whose initial Run is outside the root snapshot", () => {
  const fixture = makeFixture({
    rootSessionId: "session",
    at: 17,
    sessions: [
      {
        id: "retained-child",
        rootSessionId: "session",
        parentSessionId: "session",
        parentRunId: "root-run",
        initialRunId: "child-run-outside-snapshot",
        depth: 1,
      },
    ],
    nextBefore: null,
  })
  return Effect.scoped(
    Effect.gen(function* () {
      const client = yield* fixture.makeClient()
      const root = yield* client.sessions.snapshot({ sessionId: "session" })
      const family = yield* client.sessions.family({ sessionId: "session", limit: 64 })
      expect(root.runs.some((run) => run.runId === "child-run-outside-snapshot")).toBe(false)
      expect(family).toEqual({
        rootSessionId: "session",
        at: 17,
        sessions: [
          {
            id: "retained-child",
            rootSessionId: "session",
            parentSessionId: "session",
            parentRunId: "root-run",
            initialRunId: "child-run-outside-snapshot",
            depth: 1,
          },
        ],
        nextBefore: null,
      })
    }).pipe(Effect.ensuring(Effect.sync(fixture.dispose))),
  )
})

it.effect("authenticates every Generalist HTTP request through the credential callback", () => {
  const fixture = makeFixture()
  return Effect.scoped(
    Effect.gen(function* () {
      const client = yield* makeGeneralistClient({
        baseUrl: "http://client-v2-server",
        auth: {
          requestHeaders: ({ method, url }) =>
            Effect.succeed({
              authorization: "Bearer client-v2-token",
              dpop: `proof-${method}-${url}`,
            }),
          webSocketHeaders: ({ url }) =>
            Effect.succeed({
              authorization: "Bearer client-v2-token",
              dpop: `proof-GET-${url}`,
            }),
        },
      }).pipe(Effect.provideService(HttpClient.HttpClient, fixture.transport))
      const snapshot = yield* client.sessions.snapshot({ sessionId: "session" })
      expect(snapshot.session.id).toBe("session")
      expect(fixture.seen[0]?.headers.authorization).toBe("Bearer client-v2-token")
      expect(fixture.seen[0]?.headers.dpop).toContain("proof-GET-http://client-v2-server/sessions/session")
    }).pipe(Effect.ensuring(Effect.sync(fixture.dispose))),
  )
})
