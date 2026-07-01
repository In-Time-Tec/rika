import { html, type Document, type Html } from "foldkit/html"
import {
  ChangedDraft,
  ClickedNewThread,
  ClickedThread,
  SubmittedDraft,
  eventRows,
  type AppMessage,
  type Model,
  type TranscriptRow,
} from "./app"
import * as Ui from "./ui"

const H = html<AppMessage>()

export const view = (model: Model): Document => ({
  title: model.selected_thread_id === undefined ? "Rika" : `Rika · ${shortId(model.selected_thread_id)}`,
  body: H.main([H.Class("shell")], [sidebar(model), workspace(model)]),
})

const sidebar = (model: Model): Html =>
  H.aside(
    [H.Class("sidebar")],
    [
      H.div(
        [H.Class("brand")],
        [H.div([H.Class("brand-mark")], ["R"]), H.div([], [H.h1([], ["Rika"]), statusLine(model)])],
      ),
      H.div([H.Class("sidebar-actions")], [Ui.button([H.OnClick(ClickedNewThread())], ["New thread"], "ghost")]),
      H.nav(
        [H.Class("thread-list"), H.AriaLabel("Threads")],
        model.threads.map((thread) => threadButton(model, thread)),
      ),
    ],
  )

const statusLine = (model: Model): Html =>
  H.p(
    [H.Class("muted")],
    [
      model.backend === undefined ? "Local backend" : model.backend.workspace_root,
      " · ",
      model.connection === "connected"
        ? Ui.badge(["live"], "success")
        : model.connection === "failed"
          ? Ui.badge(["offline"], "danger")
          : Ui.badge([model.connection]),
    ],
  )

const threadButton = (model: Model, thread: Model["threads"][number]): Html =>
  H.button(
    [
      H.Class(Ui.cn("thread-button", model.selected_thread_id === thread.thread_id && "thread-button-selected")),
      H.OnClick(ClickedThread({ thread_id: thread.thread_id })),
    ],
    [
      H.span([H.Class("thread-title")], [thread.title_text ?? shortId(thread.thread_id)]),
      H.span([H.Class("thread-preview")], [thread.latest_message_text ?? "No messages yet"]),
    ],
  )

const workspace = (model: Model): Html =>
  H.section(
    [H.Class("workspace")],
    [
      H.header(
        [H.Class("workspace-header")],
        [
          H.div([], [H.p([H.Class("eyebrow")], ["Local development sync"]), H.h2([], [activeTitle(model)])]),
          H.div([H.Class("sequence")], [`seq ${model.last_sequence}`]),
        ],
      ),
      model.notice === undefined ? Ui.empty : H.div([H.Class("notice")], [model.notice]),
      transcript(model),
      composer(model),
    ],
  )

const transcript = (model: Model): Html => {
  const rows = eventRows(model.events)
  return Ui.card(
    [H.Class("transcript-card")],
    rows.length === 0
      ? [
          H.div(
            [H.Class("empty-state")],
            ["Open a CLI thread or submit a turn. Events will appear here from the shared subscription."],
          ),
        ]
      : rows.map(rowView),
  )
}

const rowView = (row: TranscriptRow): Html =>
  H.article(
    [
      H.Class(
        Ui.cn("event-row", row.kind === "message" && "event-row-message", row.kind === "error" && "event-row-error"),
      ),
    ],
    [
      H.div([H.Class("event-meta")], [H.span([], [`#${row.sequence}`]), H.strong([], [row.title])]),
      H.p([H.Class("event-body")], [row.body]),
    ],
  )

const composer = (model: Model): Html =>
  H.form(
    [H.Class("composer"), H.OnSubmit(SubmittedDraft())],
    [
      Ui.textarea([
        H.Value(model.draft),
        H.OnInput((value) => ChangedDraft({ value })),
        H.Placeholder(
          model.selected_thread_id === undefined ? "Start a new Rika thread" : "Send a turn to this thread",
        ),
        H.Rows(3),
        H.AriaLabel("Turn input"),
      ]),
      H.div(
        [H.Class("composer-footer")],
        [
          H.span(
            [H.Class("muted")],
            [model.pending_turn ? "Waiting for the shared event stream" : "Rendered only from durable thread events"],
          ),
          Ui.button(
            [H.Type("submit"), H.Disabled(model.draft.trim().length === 0 || model.pending_turn)],
            [model.pending_turn ? "Running" : "Send"],
          ),
        ],
      ),
    ],
  )

const activeTitle = (model: Model) => {
  const thread = model.threads.find((item) => item.thread_id === model.selected_thread_id)
  return (
    thread?.title_text ??
    (model.selected_thread_id === undefined ? "No thread selected" : shortId(model.selected_thread_id))
  )
}

const shortId = (value: string) => (value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`)
