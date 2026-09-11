/* oxlint-disable anti-slop/no-conditional-empty-object-spread -- optional client adapters are copied only when configured. */
import { BunChildProcessSpawner, BunCrypto, BunFileSystem, BunPath } from "@effect/platform-bun"
import { Crypto, Effect, Layer, ManagedRuntime } from "effect"
import type { FileSystem, Path } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"
import { createStore } from "solid-js/store"
import {
  makeThreadClient,
  ThreadClientError,
  type MakeThreadClientOptions,
  type MakeThreadClientOptionsBase,
  type ThreadExecutionOptions,
} from "@rika/client/thread"
import type { WorkspaceSeedClient } from "@rika/client/workspace-seeds"
import { createArchive, encodeArchive } from "@rika/workspace-input/archive"
import type { ArchiveCompletion, Client, ClientState, Mode, ScenarioId, ThreadView, TranscriptItem } from "./model"
import type { StoreState, StoreThread } from "./state"
import type { ProductClient } from "@rika/client/product"

type ThreadCreationRequest = Parameters<ProductClient["createThread"]>[0]

export interface ThreadCreationOptions {
  readonly owner: ThreadCreationRequest["owner"]
  readonly projectId?: string
  readonly runnerTarget?: Extract<ThreadCreationRequest, { readonly target: "runner" }>["runnerTarget"]
}

export type CreateThreadClientOptions = Omit<
  MakeThreadClientOptionsBase,
  "product" | "webSocketConstructor" | "webSocketHeaders" | "catalogScope"
> &
  ThreadExecutionOptions & {
    readonly product: ProductClient
    readonly webSocketConstructor?: MakeThreadClientOptions["webSocketConstructor"]
    readonly webSocketHeaders?: MakeThreadClientOptions["webSocketHeaders"]
    readonly creation?: ThreadCreationOptions
    readonly workspaceSeeds?: Pick<WorkspaceSeedClient, "stage">
    readonly workspace?: string
    readonly branch?: string
    readonly initialPrompt?: string
  }

const initialState = (workspace: string, branch: string | undefined): StoreState => ({
  scenario: "conversation",
  selectedThreadId: "",
  threads: [],
  mode: "medium",
  connection: "reconnecting",
  notice: "Connecting to Rika…",
  workspace,
  branch,
  previews: {},
  focusedSessionId: undefined,
})

const toThread = (
  thread: ReturnType<typeof makeThreadClient>["state"]["threads"][number],
  previews: Readonly<Record<string, readonly TranscriptItem[]>>,
): StoreThread => ({
  id: thread.id,
  title: thread.title,
  target: thread.target,
  activity: thread.activity,
  items: thread.items.length > 0 ? [...thread.items] : [...(previews[thread.id] ?? [])],
  pending: thread.pending.map((pending) => ({
    id: pending.id,
    prompt: pending.prompt,
    ...(pending.images === undefined
      ? {}
      : {
          images: pending.images.map((image) => ({
            path: image.fileName ?? image.mediaType,
            mediaType: image.mediaType,
          })),
        }),
  })),
  approval: thread.approval,
})

const connectionFor = (value: ReturnType<typeof makeThreadClient>["state"]["connection"]): ClientState["connection"] =>
  value

const errorText = (error: ThreadClientError): string => `${error.operation}: ${error.message}`

type ClientRuntimeServices = Crypto.Crypto | FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner

const clientRuntimeLayer = BunChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, BunPath.layer)),
)

export const createThreadClient = (options: CreateThreadClientOptions): Client => {
  const [state, setState] = createStore<StoreState>(initialState(options.workspace ?? "", options.branch))
  const runtime = ManagedRuntime.make(clientRuntimeLayer)
  let creating = false
  let archiving = false
  let pendingCreation: ThreadCreationRequest | undefined
  let navigationRevision = 0
  const creation = options.creation ?? { owner: { kind: "personal" as const } }
  const threadOptions = {
    product: options.product,
    catalogScope: {
      owner: creation.owner,
      ...(creation.projectId === undefined ? {} : { projectId: creation.projectId }),
    },
    ...(options.targetForThread === undefined ? {} : { targetForThread: options.targetForThread }),
    ...(options.eventCapacity === undefined ? {} : { eventCapacity: options.eventCapacity }),
    ...(options.historyPageSize === undefined ? {} : { historyPageSize: options.historyPageSize }),
    ...(options.initialThreadId === undefined ? {} : { initialThreadId: options.initialThreadId }),
    ...(options.webSocketConstructor === undefined ? {} : { webSocketConstructor: options.webSocketConstructor }),
    ...(options.webSocketHeaders === undefined ? {} : { webSocketHeaders: options.webSocketHeaders }),
  }
  const executionForThread = options.executionForThread
  const threadClient = makeThreadClient(
    executionForThread === undefined
      ? { ...threadOptions, execution: options.execution }
      : { ...threadOptions, executionForThread },
  )
  const sync = (value = threadClient.state): void => {
    const threads = value.threads.map((thread) => toThread(thread, value.previews))
    const selected = value.selectedThreadId ?? threads[0]?.id ?? ""
    setState({
      selectedThreadId: selected,
      threads,
      connection: connectionFor(value.connection),
      notice: value.notice,
      previews: Object.fromEntries(Object.entries(value.previews).map(([id, items]) => [id, [...items]])),
      focusedSessionId: value.focusedSessionId,
    })
  }
  const unsubscribe = threadClient.subscribe(sync)
  const run = <A>(effect: Effect.Effect<A, ThreadClientError, ClientRuntimeServices>): void => {
    runtime.runFork(
      effect.pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            sync()
            setState("notice", errorText(error))
          }),
        ),
        Effect.asVoid,
      ),
    )
  }
  const selected = (): ThreadView | undefined => state.threads.find((thread) => thread.id === state.selectedThreadId)
  const selectedPending = (id: string) => selected()?.pending.find((pending) => pending.id === id)
  const stageWorkspaceSeed = Effect.fn("Tui.Threads.stageWorkspaceSeed")(function* (
    request: Extract<ThreadCreationRequest, { readonly target: "orb" }>,
  ) {
    const workspaceSeeds = options.workspaceSeeds
    const workspace = options.workspace
    if (workspaceSeeds === undefined || workspace === undefined)
      return yield* ThreadClientError.make({
        kind: "protocol",
        operation: "thread.create",
        message: "A Box Thread stages the local Workspace as a seed, which this client is not configured to capture",
      })
    const archive = yield* createArchive(workspace).pipe(
      Effect.mapError((error) =>
        ThreadClientError.make({ kind: "protocol", operation: "thread.create", message: error.message }),
      ),
    )
    const staged = yield* workspaceSeeds
      .stage({
        owner: request.owner,
        ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
        archive: encodeArchive(archive),
      })
      .pipe(
        Effect.mapError((error) =>
          ThreadClientError.make({ kind: error.kind, operation: "thread.create", message: error.message }),
        ),
      )
    Object.assign(request, { workspaceSeedId: staged.workspaceSeedId })
  })
  const createThread = Effect.fn("Tui.Threads.createThread")(function* (
    target: "runner" | "orb",
    archiveThreadId?: string,
    onCreated?: ArchiveCompletion,
  ) {
    if (creating) return
    if (archiving)
      return yield* ThreadClientError.make({
        kind: "conflict",
        operation: "thread.create",
        message: "Wait for the current Thread archive to finish before creating another Thread.",
      })
    creating = true
    yield* Effect.gen(function* () {
      if (
        pendingCreation !== undefined &&
        (pendingCreation.target !== target || pendingCreation.archiveThreadId !== archiveThreadId)
      )
        return yield* ThreadClientError.make({
          kind: "conflict",
          operation: "thread.create",
          message: "Retry the pending Thread creation before choosing another execution target.",
        })
      if (pendingCreation === undefined) {
        const crypto = yield* Crypto.Crypto
        const threadId = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(() =>
            ThreadClientError.make({
              kind: "protocol",
              operation: "thread.create",
              message: "Could not allocate a Thread identity",
            }),
          ),
        )
        if (target === "orb") pendingCreation = { owner: creation.owner, threadId, target }
        else {
          const runnerTarget = creation.runnerTarget
          if (runnerTarget === undefined)
            return yield* ThreadClientError.make({
              kind: "protocol",
              operation: "thread.create",
              message: "No local Runner is registered for this client. Start a Runner or choose new in Box.",
            })
          pendingCreation = { owner: creation.owner, threadId, target, runnerTarget }
        }
        if (creation.projectId !== undefined) Object.assign(pendingCreation, { projectId: creation.projectId })
        if (archiveThreadId !== undefined) Object.assign(pendingCreation, { archiveThreadId })
      }
      if (pendingCreation.target === "orb" && pendingCreation.workspaceSeedId === undefined)
        yield* stageWorkspaceSeed(pendingCreation)
      const navigation = ++navigationRevision
      setState(
        "notice",
        target === "runner" ? "Creating a Thread on the selected machine…" : "Creating a Thread in a Box…",
      )
      const receipt = yield* options.product.createThread(pendingCreation).pipe(
        Effect.catch((error) => {
          if (error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 408)
            pendingCreation = undefined
          return ThreadClientError.make({ kind: error.kind, operation: "thread.create", message: error.message })
        }),
      )
      yield* threadClient.refreshThreads()
      if (navigation !== navigationRevision) {
        pendingCreation = undefined
        return
      }
      yield* threadClient.selectThread(receipt.threadId)
      pendingCreation = undefined
      yield* Effect.sync(() => onCreated?.())
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          creating = false
        }),
      ),
    )
  })
  const archiveCurrentThread = Effect.fn("Tui.Threads.archiveCurrentThread")(function* (
    thread: ThreadView,
    onArchived?: ArchiveCompletion,
  ) {
    if (archiving) return
    if (creating)
      return yield* ThreadClientError.make({
        kind: "conflict",
        operation: "thread.archive",
        message: "Wait for the current Thread creation to finish before archiving.",
      })
    archiving = true
    yield* Effect.gen(function* () {
      const navigation = ++navigationRevision
      yield* options.product
        .archiveThread(thread.id)
        .pipe(
          Effect.catch((error) =>
            ThreadClientError.make({ kind: error.kind, operation: "thread.archive", message: error.message }),
          ),
        )
      if (navigation !== navigationRevision || state.selectedThreadId !== thread.id)
        return yield* ThreadClientError.make({
          kind: "selection",
          operation: "thread.archive",
          message: "The selected Thread changed before archive confirmation.",
        })
      setState("notice", "Thread archived")
      yield* Effect.sync(() => onArchived?.())
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          archiving = false
        }),
      ),
    )
  })
  const archiveError = (operation: "thread.archive" | "thread.archive-and-new") =>
    ThreadClientError.make({ kind: "selection", operation, message: "Select a Thread before archiving." })
  const client: Client = {
    state,
    loadScenario: (scenario: ScenarioId) =>
      setState("notice", `The Thread client does not load offline scenario ${scenario}`),
    selectThread: (threadId) => {
      navigationRevision += 1
      run(threadClient.selectThread(threadId))
    },
    previewThread: (threadId) => run(threadClient.previewThread(threadId).pipe(Effect.ignore)),
    newThread: (target = "runner") => run(createThread(target)),
    archiveThread: (onArchived) => {
      const current = selected()
      if (current === undefined) return run(Effect.fail(archiveError("thread.archive")))
      run(archiveCurrentThread(current, onArchived))
    },
    archiveAndNewThread: (onCreated) => {
      const current = selected()
      if (current === undefined) return run(Effect.fail(archiveError("thread.archive-and-new")))
      run(createThread("runner", current.id, onCreated))
    },
    submit: (prompt, images = []) => {
      const text = prompt.trim()
      if (images.length > 0) {
        setState("notice", "Image attachments are not supported by this transport")
        return
      }
      if (text.length === 0) return
      run(threadClient.submit(text))
    },
    cancel: () => run(threadClient.cancel()),
    stop: () => run(threadClient.stop()),
    followUp: (prompt, childSessionId) => run(threadClient.followUp(prompt, childSessionId)),
    loadOlder: () => run(threadClient.loadOlder()),
    openChildSession: (sessionId) => run(threadClient.openChildSession(sessionId)),
    backToThread: () => run(threadClient.backToThread()),
    approve: (_approved: boolean) => setState("notice", "Authorization controls are provided by the Run"),
    editPending: (id, prompt) => run(threadClient.editQueued(id, prompt)),
    removePending: (id) => run(threadClient.removeQueued(id)),
    steerPending: (id) => {
      const pending = selectedPending(id)
      if (pending === undefined) return
      run(threadClient.steer(pending.prompt).pipe(Effect.andThen(threadClient.removeQueued(id))))
    },
    interruptAndSend: (prompt, images = []) => {
      const text = prompt.trim()
      if (images.length > 0) {
        setState("notice", "Image attachments are not supported by this transport")
        return
      }
      if (text.length === 0) return
      run(threadClient.cancel().pipe(Effect.andThen(threadClient.submit(text))))
    },
    setMode: (mode: Mode) => setState("mode", mode),
    dispose: Effect.sync(() => {
      unsubscribe()
    }).pipe(Effect.andThen(threadClient.dispose), Effect.andThen(runtime.disposeEffect)),
  }
  run(
    threadClient.refreshThreads().pipe(
      Effect.flatMap(() => {
        const first = options.initialThreadId ?? threadClient.state.threads[0]?.id
        if (first === undefined || navigationRevision !== 0) return Effect.void
        return threadClient.selectThread(first).pipe(
          Effect.flatMap(() => {
            const prompt = options.initialPrompt
            return prompt === undefined || prompt.trim().length === 0 || navigationRevision !== 0
              ? Effect.void
              : threadClient.submit(prompt)
          }),
        )
      }),
    ),
  )
  return client
}
