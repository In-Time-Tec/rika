/* oxlint-disable anti-slop/no-conditional-empty-object-spread -- optional hosted adapters are copied only when configured. */
import { Effect, Layer, ManagedRuntime } from "effect"
import { createStore } from "solid-js/store"
import { makeThreadClient, type MakeThreadClientOptions, type ThreadClientError } from "@rika/client-v2/thread"
import type { Client, ClientState, Mode, ScenarioId, ThreadView } from "./model"
import type { StoreState, StoreThread } from "./state"
import type { ProductClient } from "@rika/client-v2/product"
import type { ExecutionClient } from "@rika/client-v2/generalist"

export interface CreateHostedClientOptions
  extends Omit<MakeThreadClientOptions, "product" | "execution" | "webSocketConstructor" | "webSocketHeaders"> {
  readonly product: ProductClient
  readonly execution: ExecutionClient
  readonly webSocketConstructor?: MakeThreadClientOptions["webSocketConstructor"]
  readonly webSocketHeaders?: MakeThreadClientOptions["webSocketHeaders"]
  readonly initialThreadId?: string
}

const hostedState = (): StoreState => ({
  scenario: "conversation",
  selectedThreadId: "",
  threads: [],
  mode: "medium",
  connection: "reconnecting",
  notice: "Connecting to hosted Rika…",
  focusedSessionId: undefined,
})

const toThread = (thread: ReturnType<typeof makeThreadClient>["state"]["threads"][number]): StoreThread => ({
  id: thread.id,
  title: thread.title,
  target: thread.target,
  activity: thread.activity,
  items: [...thread.items],
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

export const createHostedClient = (options: CreateHostedClientOptions): Client => {
  const [state, setState] = createStore<StoreState>(hostedState())
  const runtime = ManagedRuntime.make(Layer.empty)
  const threadOptions: MakeThreadClientOptions = {
    product: options.product,
    execution: options.execution,
    ...(options.executionForThread === undefined ? {} : { executionForThread: options.executionForThread }),
    ...(options.targetForThread === undefined ? {} : { targetForThread: options.targetForThread }),
    ...(options.eventCapacity === undefined ? {} : { eventCapacity: options.eventCapacity }),
    ...(options.historyPageSize === undefined ? {} : { historyPageSize: options.historyPageSize }),
    ...(options.initialThreadId === undefined ? {} : { initialThreadId: options.initialThreadId }),
    ...(options.webSocketConstructor === undefined ? {} : { webSocketConstructor: options.webSocketConstructor }),
    ...(options.webSocketHeaders === undefined ? {} : { webSocketHeaders: options.webSocketHeaders }),
  }
  const threadClient = makeThreadClient(threadOptions)
  const sync = (value = threadClient.state): void => {
    const threads = value.threads.map(toThread)
    const selected = value.selectedThreadId ?? threads[0]?.id ?? ""
    setState({
      selectedThreadId: selected,
      threads,
      connection: connectionFor(value.connection),
      notice: value.notice,
      focusedSessionId: value.focusedSessionId,
    })
  }
  const unsubscribe = threadClient.subscribe(sync)
  const run = <A>(effect: Effect.Effect<A, ThreadClientError>): void => {
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
  const client: Client = {
    state,
    loadScenario: (scenario: ScenarioId) =>
      setState("notice", `Hosted client does not load offline scenario ${scenario}`),
    selectThread: (threadId) => run(threadClient.selectThread(threadId)),
    newThread: (_target?: "runner" | "orb") => setState("notice", "Create Thread from the hosted product surface"),
    archiveThread: () => setState("notice", "Archive Thread from the hosted product surface"),
    submit: (prompt, images = []) => {
      const text = prompt.trim()
      if (images.length > 0) {
        setState("notice", "Hosted image attachments are not supported by this transport")
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
    approve: (_approved: boolean) => setState("notice", "Authorization controls are provided by the hosted Run"),
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
        setState("notice", "Hosted image attachments are not supported by this transport")
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
        return first === undefined ? Effect.void : threadClient.selectThread(first)
      }),
    ),
  )
  return client
}
