import { html, type Document, type Html } from "foldkit/html"
import {
  CancelledKillOrb,
  ChangedDraft,
  ClickedKillOrb,
  ClickedNewThread,
  ClickedPauseOrb,
  ClickedResumeOrb,
  ClickedThread,
  ConfirmedKillOrb,
  GotOrbTabsMessage,
  SubmittedDraft,
  contextUsage,
  eventRows,
  OrbTabItems,
  type AppMessage,
  type ContextUsage,
  type Model,
  type OrbTab,
  type TranscriptRow,
} from "./app"
import * as Ui from "./ui"

const H = html<AppMessage>()
const OrbTabsView = Ui.Tabs.create<OrbTab>()

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
      thread.orb_status === undefined
        ? Ui.empty
        : Ui.badge([`orb ${thread.orb_status}`], orbBadgeTone(thread.orb_status)),
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
          H.div(
            [H.Class("header-status")],
            [contextMeter(model), H.div([H.Class("sequence")], [`seq ${model.last_sequence}`])],
          ),
        ],
      ),
      orbHeader(model),
      model.notice === undefined ? Ui.empty : H.div([H.Class("notice")], [model.notice]),
      hasOrbWorkspace(model) ? orbTabs(model) : transcript(model),
      composer(model),
    ],
  )

const contextMeter = (model: Model): Html => {
  const usage = contextUsage(model)
  if (usage === undefined) return Ui.empty
  return H.div(
    [H.Class(Ui.cn("context-meter", contextMeterToneClass(usage)))],
    [
      H.span([], [`ctx ${usage.percent}%`]),
      H.progress(
        [H.Class("context-meter-bar"), H.Max("100"), H.Value(String(usage.percent)), H.AriaLabel("Context usage")],
        [],
      ),
    ],
  )
}

const contextMeterToneClass = (usage: ContextUsage) => {
  if (usage.tone === "danger") return "context-meter-danger"
  if (usage.tone === "warning") return "context-meter-warning"
  return "context-meter-normal"
}

const orbHeader = (model: Model): Html => {
  const orb = model.selected_orb
  if (orb === undefined) return Ui.empty
  const confirmingKill = model.confirm_kill_orb_id === orb.orb_id
  return H.section(
    [H.Class("orb-header")],
    [
      H.div(
        [H.Class("orb-status")],
        [
          Ui.badge([orb.status], orbBadgeTone(orb.status)),
          H.span([], [`last active ${relativeTime(orb.last_active_at)}`]),
          H.span([], [`runtime ${runningMinutes(orb)}m`]),
          H.span([], [orb.base_commit === null ? "base pending" : `base ${shortId(orb.base_commit)}`]),
        ],
      ),
      H.div(
        [H.Class("orb-actions")],
        [
          Ui.button(
            [H.Type("button"), H.Disabled(orb.status !== "running"), H.OnClick(ClickedPauseOrb())],
            ["Pause"],
            "ghost",
          ),
          Ui.button(
            [H.Type("button"), H.Disabled(orb.status !== "paused"), H.OnClick(ClickedResumeOrb())],
            ["Resume"],
            "ghost",
          ),
          confirmingKill ? Ui.button([H.Type("button"), H.OnClick(CancelledKillOrb())], ["Cancel"], "ghost") : Ui.empty,
          Ui.button(
            [
              H.Type("button"),
              H.Disabled(orb.status === "killed"),
              H.OnClick(confirmingKill ? ConfirmedKillOrb() : ClickedKillOrb()),
            ],
            [confirmingKill ? "Confirm kill" : "Kill"],
            "danger",
          ),
        ],
      ),
    ],
  )
}

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

const orbTabs = (model: Model): Html =>
  H.submodel({
    slotId: "orb-tabs",
    model: model.orb_tabs,
    view: OrbTabsView.view,
    viewInputs: {
      items: OrbTabItems,
      ariaLabel: "Orb workspace",
      panel: (tab) => orbTabPanel(model, tab),
    },
    toParentMessage: (message) => GotOrbTabsMessage({ message }),
  })

const orbTabPanel = (model: Model, tab: OrbTab): Html => {
  if (tab === "transcript") return transcript(model)
  if (tab === "files") return downstreamPanel("Files arrive with #58")
  if (tab === "changes") return downstreamPanel("Changes arrive with #58")
  return downstreamPanel("Terminal arrives with #59")
}

const downstreamPanel = (label: string): Html =>
  Ui.card([H.Class("placeholder-card")], [H.div([H.Class("empty-state")], [label])])

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
      Ui.textarea({
        id: "turn-input",
        value: model.draft,
        onInput: (value) => ChangedDraft({ value }),
        placeholder: model.selected_thread_id === undefined ? "Start a new Rika thread" : "Send a turn to this thread",
        rows: 3,
        attributes: [H.AriaLabel("Turn input")],
      }),
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

const hasOrbWorkspace = (model: Model) => {
  const thread = model.threads.find((item) => item.thread_id === model.selected_thread_id)
  return model.selected_orb !== undefined || thread?.orb_status !== undefined
}

const orbBadgeTone = (status: Model["threads"][number]["orb_status"]) => {
  if (status === "running") return "success"
  if (status === "paused") return "warning"
  if (status === "killed") return "danger"
  return "default"
}

const relativeTime = (timestamp: number) => {
  const delta = Date.now() - timestamp
  if (delta < 60_000) return "just now"
  const minutes = Math.max(1, Math.floor(delta / 60_000))
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

const runningMinutes = (orb: NonNullable<Model["selected_orb"]>) =>
  Math.max(0, Math.round((orb.last_active_at - orb.created_at) / 60_000))

const shortId = (value: string) => (value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`)
