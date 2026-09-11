/* oxlint-disable effecttsgo/global-fetch -- this is the owning Bun process's Fetch boundary. */
import { makeFileCredentialAuth } from "@rika/client/credentials"
import { makeExecutionClient, makeGeneralistClient, type ExecutionClient } from "@rika/client/generalist"
import { makeFetchTransport, makeProductClient, type ProductClient } from "@rika/client/product"
import { makeWorkspaceSeedClient, type WorkspaceSeedClient } from "@rika/client/workspace-seeds"
import * as ProductOperation from "@rika/product/product-operation"
import { createArchive, encodeArchive } from "@rika/workspace-input/archive"
import type { EncodedArchive } from "@rika/workspace-input/contract"
import { Console, Crypto, Effect, Option, Ref, Schema, Stream } from "effect"
import type { HttpClient } from "effect/unstable/http"
import type { Input as HostedInput } from "../command/root/hosted"
import type { Input as RunnerInput } from "../command/root/runner"
import { selectedProfile } from "../hosted/account/session"
import type { Profile } from "../hosted/contract"
import { gitOutput } from "../platform/git"
import type { ThreadCreationOptions } from "@rika/tui-v2/src/client/threads"
import { runHeadlessWithClients } from "./headless"
import { loadConnectedTui } from "./tui-launch.js"

type InteractiveInput = Extract<ProductOperation.Input, { readonly _tag: "Interactive" }>
type RemoteRunInput = Extract<HostedInput, { readonly _tag: "RemoteRun" }>

const unavailable = (operation: string, message: string) =>
  ProductOperation.OperationUnavailable.make({ operation, message })

const asUnavailable = (operation: string) => (error: { readonly message: string }) =>
  unavailable(operation, error.message)

const commandId = Effect.fn("RikaOnline.commandId")(function* (operation: string) {
  const crypto = yield* Crypto.Crypto
  const id = yield* crypto.randomUUIDv4.pipe(
    Effect.mapError(() => unavailable(operation, "Could not allocate a command identity")),
  )
  return `rika:${operation}:${id}`
})

export interface OnlineClients {
  readonly product: Pick<ProductClient, "thread" | "ensureSession">
  readonly execution: (threadId: string) => Effect.Effect<RemoteExecutionClient, never, HttpClient.HttpClient>
}

export interface OnlineOrbClients {
  readonly profile: Profile
  readonly product: Pick<ProductClient, "createThread">
  readonly workspaceSeeds: Pick<WorkspaceSeedClient, "stage">
}

export type RemoteExecutionClient = Pick<
  ExecutionClient,
  "snapshot" | "submit" | "subscribe" | "removeInput" | "cancel"
>

export const connect = Effect.fn("RikaOnline.connect")(function* () {
  const profile = yield* selectedProfile().pipe(Effect.mapError(asUnavailable("Hosted client")))
  const auth = yield* makeFileCredentialAuth({ origin: profile.origin, fetch: globalThis.fetch }).pipe(
    Effect.mapError(asUnavailable("Hosted client")),
  )
  const requestHeaders = auth.requestHeaders
  if (requestHeaders === undefined)
    return yield* unavailable("Hosted client", "HTTP credentials were not provided by the authenticated client")
  const transport = makeFetchTransport((request) => globalThis.fetch(request))
  return {
    profile,
    auth,
    product: makeProductClient({ baseUrl: profile.origin, transport, requestHeaders }),
    workspaceSeeds: makeWorkspaceSeedClient({ baseUrl: profile.origin, transport, requestHeaders }),
    execution: (threadId: string) =>
      makeGeneralistClient({ baseUrl: runtimeUrl(profile.origin, threadId), auth }).pipe(
        Effect.map(makeExecutionClient),
      ),
  }
})

export const creationOptions = (profile: Profile): ThreadCreationOptions => {
  const owner: ThreadCreationOptions["owner"] =
    profile.owner.kind === "personal"
      ? { kind: "personal" }
      : { kind: "organization", organization_id: profile.owner.organizationId }
  return profile.project === undefined ? { owner } : { owner, projectId: profile.project }
}

export const mostRecentThread = Effect.fn("RikaOnline.mostRecentThread")(function* (
  profile: Profile,
  product: Pick<ProductClient, "listThreads">,
) {
  const page = yield* product
    .listThreads({ limit: 1, scope: creationOptions(profile) })
    .pipe(Effect.mapError(asUnavailable("Interactive")))
  const thread = page.threads[0]
  if (thread === undefined) return yield* unavailable("Interactive", "No existing Thread is available for --last")
  return thread.id
})

export const runInteractive = Effect.fn("RikaOnline.runInteractive")(function* (input: InteractiveInput) {
  if (input.ephemeral) return yield* unavailable("Interactive", "Hosted Threads are durable; remove --ephemeral")
  if (input.mode !== undefined)
    return yield* unavailable("Interactive", "The connected TUI does not support selecting a model mode at launch")

  const clients = yield* connect()
  const selectedThreadId =
    input.last === true ? yield* mostRecentThread(clients.profile, clients.product) : input.threadId
  const connection = {
    apiUrl: clients.profile.origin,
    workspace: input.workspace ?? process.cwd(),
    target: "runner" as const,
    auth: clients.auth,
    creation: creationOptions(clients.profile),
  }
  if (selectedThreadId !== undefined) Object.assign(connection, { threadId: selectedThreadId })
  const initialPrompt = input.prompt.join("\n").trim()
  if (initialPrompt.length > 0) Object.assign(connection, { initialPrompt })
  const tui = yield* loadConnectedTui.pipe(Effect.mapError(asUnavailable("Interactive")))
  yield* tui
    .launch({ scenario: "welcome", animate: true, connection })
    .pipe(Effect.mapError(asUnavailable("Interactive")))
})

const runtimeUrl = (origin: string, threadId: string) =>
  new URL(`/api/v2/threads/${encodeURIComponent(threadId)}/runtime`, origin).toString()

const startedRun = (execution: RemoteExecutionClient, sessionId: string, cursor: number, inputId: string) =>
  execution.subscribe({ sessionId, cursor }).pipe(
    Stream.filter(
      (event) =>
        event._tag === "RunStarted" && event.event.parentRunId === undefined && event.event.correlationId === inputId,
    ),
    Stream.runHead,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(unavailable("RemoteRun", "The Run event stream ended before input admission")),
        onSome: (event) =>
          event._tag === "RunStarted"
            ? Effect.succeed(event)
            : Effect.fail(unavailable("RemoteRun", "The Run event stream returned an invalid admission event")),
      }),
    ),
    Effect.mapError((error) =>
      Schema.is(ProductOperation.OperationUnavailable)(error)
        ? error
        : unavailable("RemoteRun", "The Run event stream could not be read"),
    ),
  )

const completedRun = (execution: RemoteExecutionClient, sessionId: string, cursor: number, runId: string) =>
  execution.subscribe({ sessionId, cursor }).pipe(
    Stream.filter((event) => event._tag === "Completed" && event.runId === runId),
    Stream.runHead,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(unavailable("RemoteRun", "The Run event stream ended before completion")),
        onSome: (event) =>
          event._tag === "Completed"
            ? Effect.succeed(event)
            : Effect.fail(unavailable("RemoteRun", "The Run event stream returned an invalid completion event")),
      }),
    ),
    Effect.mapError((error) =>
      Schema.is(ProductOperation.OperationUnavailable)(error)
        ? error
        : unavailable("RemoteRun", "The Run event stream could not be read"),
    ),
  )

const cancelSubmitted = (
  execution: RemoteExecutionClient,
  sessionId: string,
  inputId: string,
  runId: Ref.Ref<string | undefined>,
  initialCursor: Ref.Ref<number | undefined>,
) =>
  Effect.gen(function* () {
    const cancelCommandId = `rika:interrupt:${inputId}`
    const activeRunId = yield* Ref.get(runId)
    if (activeRunId !== undefined) {
      yield* execution.cancel({
        runId: activeRunId,
        commandId: cancelCommandId,
        reason: "Rika client interrupted",
      })
      return
    }
    const snapshot = yield* Effect.result(execution.snapshot({ sessionId }))
    if (snapshot._tag === "Success") {
      const pending = snapshot.success.session.queue.find((candidate) => candidate.id === inputId)
      if (pending !== undefined) {
        yield* execution.removeInput({
          sessionId,
          id: inputId,
          commandId: cancelCommandId,
          expectedRevision: pending.revision,
        })
        return
      }
    }
    const cursor = yield* Ref.get(initialCursor)
    if (cursor === undefined) return
    const started = yield* startedRun(execution, sessionId, cursor, inputId).pipe(Effect.timeout("1 second"))
    yield* execution.cancel({
      runId: started.runId,
      commandId: cancelCommandId,
      reason: "Rika client interrupted",
    })
  }).pipe(Effect.ignore)

export const runRemoteWithClients = Effect.fn("RikaOnline.runRemoteWithClients")(function* (
  input: RemoteRunInput,
  clients: OnlineClients,
) {
  if (input.request.mode !== undefined)
    return yield* unavailable("RemoteRun", "Per-command model modes are not supported by the V2 Runtime")
  if (input.request.review === true)
    return yield* unavailable("RemoteRun", "The V2 Runtime does not expose a separate review command")
  const prompt = input.request.prompt.join("\n").trim()
  yield* clients.product.thread(input.threadId).pipe(Effect.mapError(asUnavailable("RemoteRun")))
  const sessionId = yield* clients.product.ensureSession(input.threadId, yield* commandId("session")).pipe(
    Effect.map((receipt) => receipt.sessionId),
    Effect.mapError(asUnavailable("RemoteRun")),
  )
  const execution = yield* clients.execution(input.threadId)
  const inputId = yield* commandId("submit")
  const activeRunId = yield* Ref.make<string | undefined>(undefined)
  const initialCursor = yield* Ref.make<number | undefined>(undefined)
  const terminal = yield* Effect.gen(function* () {
    const snapshot = yield* execution
      .snapshot({ sessionId })
      .pipe(Effect.mapError(() => unavailable("RemoteRun", "The Thread Session could not be read")))
    yield* Ref.set(initialCursor, snapshot.cursor)
    const receipt = yield* execution
      .submit({ sessionId, commandId: inputId, input: prompt })
      .pipe(Effect.mapError(() => unavailable("RemoteRun", "The prompt could not be submitted")))
    const started = yield* startedRun(execution, sessionId, snapshot.cursor, receipt.id)
    yield* Ref.set(activeRunId, started.runId)
    return yield* completedRun(execution, sessionId, started.cursor, started.runId)
  }).pipe(Effect.onInterrupt(() => cancelSubmitted(execution, sessionId, inputId, activeRunId, initialCursor)))
  if (terminal.event._tag === "RunFailed")
    return yield* unavailable("RemoteRun", "The Run failed before producing a final answer")
  if (terminal.event._tag === "RunCancelled")
    return yield* unavailable("RemoteRun", "The Run was cancelled before producing a final answer")
  const result = terminal.event.result
  if (!("text" in result)) return yield* unavailable("RemoteRun", "The Run completed without an Agent answer")
  yield* Console.log(result.text)
})

export const runRemote = Effect.fn("RikaOnline.runRemote")(function* (input: RemoteRunInput) {
  return yield* runRemoteWithClients(input, yield* connect())
})

export const runHeadless = Effect.fn("RikaOnline.runHeadless")(function* (input: RunnerInput) {
  const clients = yield* connect()
  return yield* runHeadlessWithClients(input, clients)
})

export const createOrbThreadWithClients = Effect.fn("RikaOnline.createOrbThreadWithClients")(function* (
  clients: OnlineOrbClients,
  archive: EncodedArchive,
) {
  const creation = creationOptions(clients.profile)
  const staged = yield* clients.workspaceSeeds
    .stage({ ...creation, archive })
    .pipe(Effect.mapError(asUnavailable("RemoteThread")))
  const request = {
    ...creation,
    threadId: yield* commandId("thread"),
    target: "orb" as const,
    workspaceSeedId: staged.workspaceSeedId,
  } satisfies Parameters<ProductClient["createThread"]>[0]
  const receipt = yield* clients.product.createThread(request).pipe(Effect.mapError(asUnavailable("RemoteThread")))
  yield* Console.log(`Created Orb Thread ${receipt.threadId}`)
})

export const createOrbThread = Effect.fn("RikaOnline.createOrbThread")(function* (
  _input: Extract<HostedInput, { readonly _tag: "RemoteThread" }>,
) {
  const clients = yield* connect()
  const workspace = process.cwd()
  const root = (yield* gitOutput(workspace, ["rev-parse", "--show-toplevel"])) ?? workspace
  const archive = yield* createArchive(root).pipe(Effect.mapError(asUnavailable("RemoteThread")))
  yield* createOrbThreadWithClients(clients, encodeArchive(archive))
})
