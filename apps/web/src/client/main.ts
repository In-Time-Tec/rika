import { Effect, Function, Schema, Stream } from "effect"
import { define, type Command } from "foldkit/command"
import * as Input from "@foldkit/ui/input"
import * as Textarea from "@foldkit/ui/textarea"
import type { Document, HtmlBuilder } from "foldkit/html"
import { m } from "foldkit/message"
import type { ApplicationInit } from "foldkit/runtime"
import { Subscription } from "foldkit"
import { connectThread, frameEventName, openPortal, sendPrompt } from "./thread-socket"
import { html, htmlScope } from "./html"

export const ConnectionState = Schema.Literals(["disconnected", "connecting", "connected", "failed"])

export const Model = Schema.Struct({
  connection: ConnectionState,
  threadId: Schema.String,
  threadVersion: Schema.String,
  draft: Schema.String,
  portalPort: Schema.String,
  portalUrl: Schema.NullOr(Schema.String),
  frames: Schema.Array(Schema.String),
  error: Schema.NullOr(Schema.String),
})
export type Model = typeof Model.Type

export const ChangedThreadId = m("ChangedThreadId", { value: Schema.String })
export const ChangedDraft = m("ChangedDraft", { value: Schema.String })
export const ClickedConnect = m("ClickedConnect")
export const SubmittedPrompt = m("SubmittedPrompt")
export const ChangedPortalPort = m("ChangedPortalPort", { value: Schema.String })
export const ClickedOpenPortal = m("ClickedOpenPortal")
export const ConnectedThread = m("ConnectedThread", { threadId: Schema.String })
export const FailedThreadAction = m("FailedThreadAction", { message: Schema.String })
export const SentPrompt = m("SentPrompt")
export const SentPortalRequest = m("SentPortalRequest")
export const GotThreadFrame = m("GotThreadFrame", { frame: Schema.Unknown })

export const Message = Schema.Union([
  ChangedThreadId,
  ChangedDraft,
  ChangedPortalPort,
  ClickedConnect,
  ClickedOpenPortal,
  SubmittedPrompt,
  ConnectedThread,
  FailedThreadAction,
  SentPrompt,
  SentPortalRequest,
  GotThreadFrame,
])
export type Message = typeof Message.Type

type ProgramCommand = Command<Message, never, never>
type Update = readonly [Model, ReadonlyArray<ProgramCommand>]

export const ConnectThread = define("ConnectThread", {
  args: { threadId: Schema.String },
  messages: [ConnectedThread, FailedThreadAction],
  execute: ({ threadId }) =>
    connectThread(threadId).pipe(
      Effect.match({
        onFailure: (error) => FailedThreadAction({ message: error.message }),
        onSuccess: (connected) => ConnectedThread({ threadId: connected }),
      }),
    ),
})

export const SubmitThreadPrompt = define("SubmitThreadPrompt", {
  args: { threadId: Schema.String, threadVersion: Schema.String, text: Schema.String },
  messages: [SentPrompt, FailedThreadAction],
  execute: (input) =>
    sendPrompt(input).pipe(
      Effect.match({
        onFailure: (error) => FailedThreadAction({ message: error.message }),
        onSuccess: () => SentPrompt(),
      }),
    ),
})

export const OpenThreadPortal = define("OpenThreadPortal", {
  args: { port: Schema.Int },
  messages: [SentPortalRequest, FailedThreadAction],
  execute: ({ port }) =>
    openPortal(port).pipe(
      Effect.match({
        onFailure: (error) => FailedThreadAction({ message: error.message }),
        onSuccess: () => SentPortalRequest(),
      }),
    ),
})

export const init: ApplicationInit<Model, Message, void> = () => [
  {
    connection: "disconnected",
    threadId: "",
    threadVersion: "0",
    draft: "",
    portalPort: "3000",
    portalUrl: null,
    frames: [],
    error: null,
  },
  [],
]

const frameText = (frame: unknown): string => {
  try {
    return JSON.stringify(frame, null, 2)
  } catch {
    return "Unserializable Thread frame"
  }
}

const updateModel = (model: Model, message: Message): Update => {
  switch (message._tag) {
    case "ChangedThreadId":
      return [{ ...model, threadId: message.value }, []]
    case "ChangedDraft":
      return [{ ...model, draft: message.value }, []]
    case "ChangedPortalPort":
      return [{ ...model, portalPort: message.value }, []]
    case "ClickedOpenPortal": {
      const port = Number(model.portalPort)
      return model.connection !== "connected" || !Number.isSafeInteger(port) || port < 1 || port > 65_535
        ? [{ ...model, error: "Portal port must be between 1 and 65535" }, []]
        : [{ ...model, error: null }, [OpenThreadPortal({ port })]]
    }
    case "ClickedConnect": {
      const threadId = model.threadId.trim()
      return threadId.length === 0
        ? [{ ...model, connection: "failed", error: "Enter a Thread ID" }, []]
        : [{ ...model, connection: "connecting", error: null }, [ConnectThread({ threadId })]]
    }
    case "ConnectedThread":
      return [{ ...model, connection: "connected", threadId: message.threadId, error: null }, []]
    case "FailedThreadAction":
      return [{ ...model, connection: "failed", error: message.message }, []]
    case "SubmittedPrompt": {
      const text = model.draft.trim()
      return model.connection !== "connected" || text.length === 0
        ? [model, []]
        : [
            { ...model, draft: "", error: null },
            [SubmitThreadPrompt({ threadId: model.threadId, threadVersion: model.threadVersion, text })],
          ]
    }
    case "SentPrompt":
      return [model, []]
    case "SentPortalRequest":
      return [model, []]
    case "GotThreadFrame": {
      const frame = message.frame as {
        readonly payload?: { readonly threadVersion?: unknown; readonly _tag?: unknown; readonly url?: unknown }
      }
      const version = frame.payload?.threadVersion
      const disconnected = frame.payload?._tag === "ClientDisconnected"
      const portalUrl =
        frame.payload?._tag === "PortalOpened" && typeof frame.payload.url === "string"
          ? frame.payload.url
          : model.portalUrl
      return [
        {
          ...model,
          connection: disconnected ? "disconnected" : model.connection,
          threadVersion: typeof version === "string" ? version : model.threadVersion,
          portalUrl,
          frames: [...model.frames.slice(-199), frameText(message.frame)],
          error: disconnected ? "Thread connection closed" : model.error,
        },
        [],
      ]
    }
  }
}

export const update: {
  (model: Model, message: Message): Update
  (message: Message): (model: Model) => Update
} = Function.dual(2, updateModel)

export const subscriptions = Subscription.make<Model, Message>()(() => ({
  threadFrames: Subscription.persistent(
    Subscription.fromEvent<CustomEvent<unknown>, CustomEvent<unknown>>({
      target: window,
      type: frameEventName,
      toMessage: (event) => event,
    }).pipe(Stream.map((event) => GotThreadFrame({ frame: event.detail }))),
  ),
}))
export const view: {
  (model: Model, builder: HtmlBuilder<Message>): Document
  (builder: HtmlBuilder<Message>): (model: Model) => Document
} = Function.dual(
  2,
  (model: Model, builder: HtmlBuilder<Message>): Document =>
    htmlScope.with(builder, () => {
      const h = html<Message>()
      const connected = model.connection === "connected"
      return {
        title: model.threadId.length === 0 ? "Rika Threads" : `Rika · ${model.threadId}`,
        body: h.main(
          [h.Class("shell")],
          [
            h.header(
              [h.Class("header")],
              [
                h.div([], [h.h1([], ["Rika"]), h.p([], ["Durable Runner and Orb Threads"])]),
                h.span([h.Class(`status status-${model.connection}`)], [model.connection]),
              ],
            ),
            h.form(
              [h.Class("connect"), h.OnSubmit(ClickedConnect())],
              [
                Input.view(
                  {
                    id: "thread-id",
                    value: model.threadId,
                    placeholder: "thread-id",
                    onInput: (value) => ChangedThreadId({ value }),
                    toView: (attributes) =>
                      h.div([], [h.label([...attributes.label], ["Thread ID"]), h.input([...attributes.input])]),
                  },
                  h,
                ),
                h.button([h.Type("submit"), h.Disabled(model.connection === "connecting")], ["Connect"]),
              ],
            ),
            ...(model.error === null ? [] : [h.p([h.Class("error"), h.Role("alert")], [model.error])]),
            h.form(
              [h.Class("connect"), h.OnSubmit(ClickedOpenPortal())],
              [
                Input.view(
                  {
                    id: "portal-port",
                    value: model.portalPort,
                    placeholder: "3000",
                    isDisabled: !connected,
                    onInput: (value) => ChangedPortalPort({ value }),
                    toView: (attributes) =>
                      h.div([], [h.label([...attributes.label], ["Portal port"]), h.input([...attributes.input])]),
                  },
                  h,
                ),
                h.button([h.Type("submit"), h.Disabled(!connected)], ["Open portal"]),
              ],
            ),
            ...(model.portalUrl === null
              ? []
              : [h.p([], [h.a([h.Href(model.portalUrl), h.Target("_blank")], [model.portalUrl])])]),
            h.section(
              [h.Class("transcript"), h.AriaLabel("Thread event stream")],
              [
                ...(model.frames.length === 0
                  ? [h.p([h.Class("empty")], ["Connect to a Thread to inspect its durable stream."])]
                  : model.frames.map((frame, index) => h.keyed("pre")(`${index}:${frame.length}`, [], [frame]))),
              ],
            ),
            h.form(
              [h.Class("composer"), h.OnSubmit(SubmittedPrompt())],
              [
                Textarea.view(
                  {
                    id: "thread-prompt",
                    value: model.draft,
                    placeholder: "Continue the Thread…",
                    isDisabled: !connected,
                    onInput: (value) => ChangedDraft({ value }),
                    toView: (attributes) =>
                      h.div([], [h.label([...attributes.label], ["Prompt"]), h.textarea([...attributes.textarea])]),
                  },
                  h,
                ),
                h.button([h.Type("submit"), h.Disabled(!connected || model.draft.trim().length === 0)], ["Send"]),
              ],
            ),
          ],
        ),
      }
    }),
)
