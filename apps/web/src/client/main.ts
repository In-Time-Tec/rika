import { Effect, Function, Layer, Match, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { define, type Command } from "foldkit/command"
import * as Input from "@foldkit/ui/input"
import type { Document, HtmlBuilder } from "foldkit/html"
import { m } from "foldkit/message"
import type { ApplicationInit } from "foldkit/runtime"
import { Subscription } from "foldkit"
import * as Socket from "effect/unstable/socket/Socket"
import { ThreadSummary } from "@rika/product/thread-summary"
import { ThreadViewSnapshot } from "@rika/product/thread-view"
import { protocolVersion } from "@rika/product/client-protocol"
import { connectThread, frameEventName } from "./thread-socket"
import { transcriptUnit } from "./transcript"

const BrowserFrame = Schema.Struct({
  protocolVersion: Schema.Literal(protocolVersion),
  view: Schema.optionalKey(ThreadViewSnapshot),
  payload: Schema.Struct({
    _tag: Schema.String,
    threadId: Schema.optionalKey(Schema.String),
    message: Schema.optionalKey(Schema.String),
    event: Schema.optionalKey(Schema.Struct({ threadId: Schema.String })),
  }),
})
export const Model = Schema.Struct({
  connection: Schema.Literals(["disconnected", "connecting", "connected", "failed"]),
  threadId: Schema.String,
  attachedThreadId: Schema.NullOr(Schema.String),
  connectionEpoch: Schema.Int,
  snapshot: Schema.NullOr(ThreadViewSnapshot),
  threads: Schema.Array(ThreadSummary),
  loadingThreads: Schema.Boolean,
  listEpoch: Schema.Int,
  organization: Schema.String,
  search: Schema.String,
  archived: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  listError: Schema.NullOr(Schema.String),
})
export type Model = typeof Model.Type
export const ChangedThreadId = m("ChangedThreadId", { value: Schema.String })
export const ChangedSearch = m("ChangedSearch", { value: Schema.String })
export const ChangedOrganization = m("ChangedOrganization", { value: Schema.String })
export const ToggledArchived = m("ToggledArchived")
export const ClickedConnect = m("ClickedConnect")
export const SelectedThread = m("SelectedThread", { threadId: Schema.String })
export const RefreshThreads = m("RefreshThreads")
export const LoadedThreads = m("LoadedThreads", { epoch: Schema.Int, threads: Schema.Array(ThreadSummary) })
export const FailedThreads = m("FailedThreads", { epoch: Schema.Int, message: Schema.String })
export const ConnectedThread = m("ConnectedThread", { epoch: Schema.Int, threadId: Schema.String, frame: BrowserFrame })
export const FailedThreadConnection = m("FailedThreadConnection", { epoch: Schema.Int, message: Schema.String })
export const GotThreadFrame = m("GotThreadFrame", { frame: BrowserFrame })
export const Message = Schema.Union([
  ChangedThreadId,
  ChangedSearch,
  ChangedOrganization,
  ToggledArchived,
  ClickedConnect,
  SelectedThread,
  RefreshThreads,
  LoadedThreads,
  FailedThreads,
  ConnectedThread,
  FailedThreadConnection,
  GotThreadFrame,
])
export type Message = typeof Message.Type
type Update = readonly [Model, ReadonlyArray<Command<Message, never, never>>]

export const ListThreads = define("ListThreads", {
  args: { epoch: Schema.Int, organization: Schema.String },
  messages: [LoadedThreads, FailedThreads],
  execute: ({ epoch, organization }) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.execute(
        HttpClientRequest.post(new URL("/api/v1/threads/list", window.location.origin).href).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            owner:
              organization.trim() === ""
                ? { kind: "personal" }
                : { kind: "organization", organization_id: organization.trim() },
          }),
        ),
      )
      if (response.status !== 200)
        return yield* Effect.fail(
          response.status === 401
            ? "Sign in to review your Threads."
            : `Could not load Threads (HTTP ${response.status}).`,
        )
      return (yield* HttpClientResponse.schemaBodyJson(Schema.Struct({ threads: Schema.Array(ThreadSummary) }))(
        response,
      )).threads
    }).pipe(
      (effect) =>
        Effect.scoped(
          Layer.build(FetchHttpClient.layer).pipe(Effect.flatMap((context) => effect.pipe(Effect.provide(context)))),
        ),
      Effect.match({
        onSuccess: (threads) => LoadedThreads({ epoch, threads }),
        onFailure: (error) =>
          FailedThreads({ epoch, message: Schema.is(Schema.String)(error) ? error : "Could not load Threads." }),
      }),
    ),
})
export const ConnectThread = define("ConnectThread", {
  args: { epoch: Schema.Int, threadId: Schema.String },
  messages: [ConnectedThread, FailedThreadConnection],
  execute: ({ epoch, threadId }) =>
    Effect.scoped(
      Layer.build(Socket.layerWebSocketConstructorGlobal).pipe(
        Effect.flatMap((context) => connectThread(threadId).pipe(Effect.provide(context))),
      ),
    ).pipe(
      Effect.match({
        onSuccess: (connected) => ConnectedThread({ epoch, ...connected }),
        onFailure: (error) => FailedThreadConnection({ epoch, message: error.message }),
      }),
    ),
})
export const init: ApplicationInit<Model, Message, void> = () => [
  {
    connection: "disconnected",
    threadId: "",
    attachedThreadId: null,
    connectionEpoch: 0,
    snapshot: null,
    threads: [],
    loadingThreads: true,
    listEpoch: 1,
    organization: "",
    search: "",
    archived: false,
    error: null,
    listError: null,
  },
  [ListThreads({ epoch: 1, organization: "" })],
]

const connect = (model: Model, id = model.threadId): Update => {
  const threadId = id.trim()
  const epoch = model.connectionEpoch + 1
  return threadId === ""
    ? [{ ...model, error: "Enter a Thread ID" }, []]
    : [
        { ...model, threadId, connection: "connecting", connectionEpoch: epoch, error: null },
        [ConnectThread({ epoch, threadId })],
      ]
}
const updateModel = (model: Model, incoming: Message): Update =>
  Match.value(incoming).pipe(
    Match.tagsExhaustive({
      ChangedThreadId: (message): Update => [{ ...model, threadId: message.value }, []],
      ChangedSearch: (message): Update => [{ ...model, search: message.value }, []],
      ChangedOrganization: (message): Update => [{ ...model, organization: message.value }, []],
      ToggledArchived: (): Update => [{ ...model, archived: !model.archived }, []],
      ClickedConnect: () => connect(model),
      SelectedThread: (message) => connect(model, message.threadId),
      RefreshThreads: (): Update => [
        { ...model, loadingThreads: true, listError: null, listEpoch: model.listEpoch + 1 },
        [ListThreads({ epoch: model.listEpoch + 1, organization: model.organization })],
      ],
      LoadedThreads: (message): Update =>
        message.epoch !== model.listEpoch
          ? [model, []]
          : [{ ...model, threads: message.threads, loadingThreads: false }, []],
      FailedThreads: (message): Update =>
        message.epoch !== model.listEpoch
          ? [model, []]
          : [{ ...model, loadingThreads: false, listError: message.message }, []],
      ConnectedThread: (message): Update =>
        message.epoch !== model.connectionEpoch
          ? [model, []]
          : [
              {
                ...model,
                connection: "connected",
                attachedThreadId: message.threadId,
                threadId: message.threadId,
                snapshot: message.frame.view ?? null,
                error: null,
              },
              [],
            ],
      FailedThreadConnection: (message): Update =>
        message.epoch !== model.connectionEpoch
          ? [model, []]
          : [{ ...model, connection: "failed", error: message.message }, []],
      GotThreadFrame: (message): Update => {
        const payload = message.frame.payload
        const id = payload.threadId ?? payload.event?.threadId
        if (id !== undefined && id !== model.attachedThreadId) return [model, []]
        if (payload._tag === "ClientReconnecting") return [{ ...model, connection: "connecting", error: null }, []]
        if (["ClientReconnectFailed", "ClientDecodeFailed", "CommandRejected"].includes(payload._tag))
          return [
            {
              ...model,
              connection: "failed",
              error: payload.message ?? "Reconnection failed. Sign in again or retry.",
            },
            [],
          ]
        return [
          {
            ...model,
            snapshot: message.frame.view ?? model.snapshot,
            connection: payload._tag === "ThreadAttached" ? "connected" : model.connection,
          },
          [],
        ]
      },
    }),
  )
export const update: { (model: Model, message: Message): Update; (message: Message): (model: Model) => Update } =
  Function.dual(2, updateModel)
export const subscriptions = Subscription.make<Model, Message>()(() => ({
  threadFrames: Subscription.persistent(
    Subscription.fromEvent<CustomEvent<typeof BrowserFrame.Type>, CustomEvent<typeof BrowserFrame.Type>>({
      target: window,
      type: frameEventName,
      toMessage: (event) => event,
    }).pipe(Stream.map((event) => GotThreadFrame({ frame: event.detail }))),
  ),
}))

export const view: {
  (model: Model, builder: HtmlBuilder<Message>): Document
  (builder: HtmlBuilder<Message>): (model: Model) => Document
} = Function.dual(2, (model: Model, h: HtmlBuilder<Message>): Document => {
  const field = (id: string, label: string, value: string, onInput: (value: string) => Message) =>
    Input.view(
      {
        id,
        value,
        onInput,
        toView: (attrs) => h.div([], [h.label([...attrs.label], [label]), h.input([...attrs.input])]),
      },
      h,
    )
  const listed = model.threads.filter(
    (thread) =>
      thread.archived === model.archived &&
      `${thread.title} ${thread.id}`.toLowerCase().includes(model.search.toLowerCase()),
  )
  const snapshot = model.snapshot
  const transcript = () =>
    h.section(
      [h.Class("transcript"), h.AriaLabel("Thread transcript")],
      snapshot === null
        ? [h.p([h.Class("empty")], ["Select a Thread to review its conversation, tool results, and changes."])]
        : [
            ...(snapshot.hasOlder
              ? [h.p([h.Class("notice")], ["Showing the retained transcript window. Earlier content is not included."])]
              : []),
            ...(snapshot.turns.length === 0
              ? [h.p([h.Class("empty")], ["No Turns yet. Start work from the Rika CLI."])]
              : snapshot.turns.map((entry) =>
                  h.keyed("section")(
                    String(entry.turn.id),
                    [h.Class("turn")],
                    [
                      h.p(
                        [h.Class("turn-status")],
                        [
                          `Turn · ${"needsResolution" in entry && entry.needsResolution === true ? "needs resolution" : entry.turn.status}`,
                        ],
                      ),
                      ...entry.units.map((unit) => transcriptUnit(unit, h)),
                    ],
                  ),
                )),
            ...snapshot.pending.map((pending) =>
              h.keyed("article")(
                String(pending.id),
                [h.Class("entry pending")],
                [h.h3([], ["Queued prompt"]), h.p([], [pending.prompt])],
              ),
            ),
            ...(snapshot.hasNewer
              ? [h.p([h.Class("notice")], ["Newer content is outside this transcript window."])]
              : []),
          ],
    )
  return {
    title: snapshot === null ? "Rika Threads" : `${snapshot.thread.title} · Rika`,
    body: h.main(
      [h.Class("shell")],
      [
        h.header(
          [h.Class("header")],
          [h.div([], [h.h1([], ["Rika"]), h.p([], ["Thread review"])]), h.a([h.Href("/account")], ["Account"])],
        ),
        h.div(
          [h.Class("review-layout")],
          [
            h.aside(
              [h.Class("sidebar"), h.AriaLabel("Thread navigation")],
              [
                h.h2([], ["Threads"]),
                h.form(
                  [h.OnSubmit(RefreshThreads())],
                  [
                    field("organization", "Organization ID (blank for personal)", model.organization, (value) =>
                      ChangedOrganization({ value }),
                    ),
                    h.button([h.Type("submit")], ["Refresh list"]),
                  ],
                ),
                field("search", "Filter Threads", model.search, (value) => ChangedSearch({ value })),
                h.button(
                  [h.Type("button"), h.OnClick(ToggledArchived())],
                  [model.archived ? "Show active Threads" : "Show archived Threads"],
                ),
                ...(model.listError === null
                  ? []
                  : [
                      h.p([h.Role("alert"), h.Class("error")], [model.listError]),
                      h.a([h.Href("/login?redirect=/threads")], ["Sign in"]),
                    ]),
                ...(model.loadingThreads ? [h.p([h.Role("status")], ["Loading Threads…"])] : []),
                h.nav(
                  [],
                  listed.length === 0 && !model.loadingThreads
                    ? [
                        h.p(
                          [h.Class("muted")],
                          [model.search === "" ? "No Threads in this view." : "No matching Threads."],
                        ),
                      ]
                    : listed.map((thread) =>
                        h.keyed("button")(
                          String(thread.id),
                          [
                            h.Class(`thread-link ${thread.id === model.attachedThreadId ? "selected" : ""}`),
                            h.Type("button"),
                            h.OnClick(SelectedThread({ threadId: String(thread.id) })),
                          ],
                          [
                            h.strong([], [thread.title || "Untitled Thread"]),
                            h.span([h.Class("muted")], [String(thread.id)]),
                            h.span(
                              [h.Class("muted")],
                              [`${thread.status} · ${thread.turnCount} Turns${thread.archived ? " · archived" : ""}`],
                            ),
                          ],
                        ),
                      ),
                ),
              ],
            ),
            h.div(
              [h.Class("review")],
              [
                h.form(
                  [h.Class("connect"), h.OnSubmit(ClickedConnect())],
                  [
                    field("thread-id", "Open Thread by ID", model.threadId, (value) => ChangedThreadId({ value })),
                    h.button(
                      [h.Type("submit"), h.Disabled(model.connection === "connecting")],
                      [model.connection === "failed" ? "Retry connection" : "Open Thread"],
                    ),
                  ],
                ),
                h.div(
                  [h.Class("review-heading")],
                  [
                    h.h2([], [snapshot?.thread.title ?? "Choose a Thread"]),
                    h.span([h.Class(`status status-${model.connection}`), h.Role("status")], [model.connection]),
                  ],
                ),
                h.p(
                  [h.Class("notice")],
                  [
                    "Read-only live review. Use the Rika CLI to send prompts or cancel work. Browser viewing does not wake a Runner or announce presence.",
                  ],
                ),
                ...(model.error === null
                  ? []
                  : [
                      h.p([h.Class("error"), h.Role("alert")], [model.error]),
                      h.a([h.Href("/login?redirect=/threads")], ["Sign in again"]),
                    ]),
                ...(model.connection === "connecting"
                  ? [
                      h.p(
                        [h.Role("status")],
                        ["Loading Thread… Existing transcript is retained until attachment succeeds."],
                      ),
                    ]
                  : []),
                transcript(),
              ],
            ),
          ],
        ),
      ],
    ),
  }
})
