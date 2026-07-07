import { Common } from "@rika/schema"
import { html, type Document, type Html } from "foldkit/html"
import {
  activeTurnId,
  CancelledKillOrb,
  ChangedDraft,
  ChangedDraftMode,
  ChangedThreadSearchQuery,
  ChangedThreadSearchWindow,
  ChangedNewProjectEnvKey,
  ChangedNewProjectEnvValue,
  ChangedNewProjectField,
  ChangedProjectEnvValue,
  ChangedProjectField,
  ChangedProjectSecretField,
  ClickedInterrupt,
  ClickedDeleteProjectSecret,
  ClickedProject,
  ClickedProjects,
  ClickedTogglePierreDiff,
  ClickedKillOrb,
  ClickedNewThread,
  ClickedPauseOrb,
  ClickedResumeOrb,
  ClickedThreads,
  ClickedThread,
  CancelledDeleteProjectSecret,
  ClickedTranscriptDisclosure,
  ConfirmedKillOrb,
  ConfirmedDeleteProjectSecret,
  GotDeleteSecretDialogMessage,
  GotKillOrbDialogMessage,
  GotOrbTabsMessage,
  GotTranscriptScrollerMessage,
  MountPierreDiff,
  MountPierreTree,
  MountOrbTerminal,
  RequestedTerminalReconnect,
  RemovedProjectEnv,
  SubmittedNewProject,
  SubmittedProjectSecret,
  SubmittedProjectSettings,
  SubmittedDraft,
  contextUsage,
  eventRows,
  OrbTabItems,
  pierreTreeMountKey,
  type AppMessage,
  type ContextUsage,
  type Model,
  type OrbTab,
  type TranscriptRow,
} from "./app"
import { codeBlock, markdownContent } from "./markdown"
import * as Ui from "./ui"

const H = html<AppMessage>()
const OrbTabsView = Ui.Tabs.create<OrbTab>()
const modeOptions: ReadonlyArray<Ui.SelectOption> = [
  { value: "", label: "Default" },
  { value: "rush", label: "rush" },
  { value: "smart", label: "smart" },
  { value: "deep1", label: "deep1" },
  { value: "deep2", label: "deep2" },
  { value: "deep3", label: "deep3" },
]
const searchWindowOptions: ReadonlyArray<Ui.SelectOption> = [
  { value: "24h", label: "24h" },
  { value: "72h", label: "72h" },
  { value: "7d", label: "7d" },
  { value: "all", label: "all" },
]

const currentTimestamp = () => Common.TimestampMillis.make(Date.now())

export const view = (model: Model): Document => ({
  title: model.selected_thread_id === undefined ? "Rika" : `Rika · ${shortId(model.selected_thread_id)}`,
  body: H.main([H.Class("dark shell")], [sidebar(model), workspace(model)]),
})

const sidebar = (model: Model): Html =>
  H.aside(
    [H.Class("sidebar")],
    [
      H.div(
        [H.Class("brand")],
        [H.div([H.Class("brand-mark")], ["R"]), H.div([], [H.h1([], ["Rika"]), statusLine(model)])],
      ),
      H.div(
        [H.Class("sidebar-actions")],
        [
          Ui.button([H.Type("button"), H.OnClick(ClickedThreads())], ["Threads"], "ghost"),
          Ui.button([H.Type("button"), H.OnClick(ClickedProjects())], ["Projects"], "ghost"),
          Ui.button([H.Type("button"), H.OnClick(ClickedNewThread())], ["New thread"], "ghost"),
        ],
      ),
      threadSearchControls(model),
      H.nav(
        [H.Class("thread-list"), H.AriaLabel("Threads")],
        model.threads.map((thread) => threadButton(model, thread)),
      ),
    ],
  )

const threadSearchControls = (model: Model): Html =>
  H.div(
    [H.Class("thread-search")],
    [
      H.input([
        H.Type("search"),
        H.Value(model.thread_search_query),
        H.Placeholder("Search threads"),
        H.AriaLabel("Thread search"),
        H.OnInput((value) => ChangedThreadSearchQuery({ value, now: currentTimestamp() })),
      ]),
      Ui.select({
        id: "thread-search-window",
        value: model.thread_search_window,
        options: searchWindowOptions,
        onChange: (value) => ChangedThreadSearchWindow({ value, now: currentTimestamp() }),
        attributes: [H.AriaLabel("Thread search window")],
        class: "thread-search-window",
      }),
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
          H.div(
            [],
            [
              H.p([H.Class("eyebrow")], ["Local development sync"]),
              H.div([H.Class("thread-title-row")], [H.h2([], [activeTitle(model)]), presenceAvatars(model)]),
            ],
          ),
          H.div(
            [H.Class("header-status")],
            [contextMeter(model), H.div([H.Class("sequence")], [`seq ${model.last_sequence}`])],
          ),
        ],
      ),
      model.active_view === "projects"
        ? projectsWorkspace(model)
        : H.div(
            [H.Class("thread-workspace")],
            [
              orbHeader(model),
              killOrbDialog(model),
              model.notice === undefined ? Ui.empty : H.div([H.Class("notice")], [model.notice]),
              hasOrbWorkspace(model) ? orbTabs(model) : transcript(model),
              typingIndicator(model),
              composer(model),
            ],
          ),
    ],
  )

const projectsWorkspace = (model: Model): Html =>
  H.div(
    [H.Class("projects-workspace")],
    [
      model.notice === undefined ? Ui.empty : H.div([H.Class("notice")], [model.notice]),
      deleteSecretDialog(model),
      H.div([H.Class("projects-layout")], [projectsListPanel(model), projectDetailPanel(model)]),
    ],
  )

const projectsListPanel = (model: Model): Html =>
  Ui.Card.card({ class: "projects-list-card" }, [
    H.div([H.Class("projects-section-header")], [H.h3([], ["Projects"])]),
    model.projects.length === 0
      ? H.div([H.Class("empty-state")], ["No projects"])
      : H.div(
          [H.Class("projects-list")],
          model.projects.map((project) => projectListButton(model, project)),
        ),
    newProjectForm(model),
  ])

const projectListButton = (model: Model, project: Model["projects"][number]): Html =>
  H.button(
    [
      H.Type("button"),
      H.Class(Ui.cn("project-list-button", model.selected_project_id === project.project_id && "project-selected")),
      H.OnClick(ClickedProject({ project_id: project.project_id })),
    ],
    [
      H.span([H.Class("project-name")], [project.name]),
      H.span([H.Class("project-repo")], [project.repo_origin]),
      project.env_keys.length === 0 ? Ui.empty : Ui.badge([`${project.env_keys.length} env`], "default"),
      project.secret_names.length === 0 ? Ui.empty : Ui.badge([`${project.secret_names.length} secrets`], "warning"),
    ],
  )

const newProjectForm = (model: Model): Html =>
  H.form(
    [H.Class("project-form new-project-form"), H.OnSubmit(SubmittedNewProject())],
    [
      H.h3([], ["New project"]),
      textInput("new-project-name", "Name", model.new_project_form.name, (value) =>
        ChangedNewProjectField({ field: "name", value }),
      ),
      textInput("new-project-repo", "Repository", model.new_project_form.repo_origin, (value) =>
        ChangedNewProjectField({ field: "repo_origin", value }),
      ),
      textInput("new-project-branch", "Branch", model.new_project_form.default_branch, (value) =>
        ChangedNewProjectField({ field: "default_branch", value }),
      ),
      textInput("new-project-template", "Template", model.new_project_form.template_id, (value) =>
        ChangedNewProjectField({ field: "template_id", value }),
      ),
      H.div(
        [H.Class("env-pair")],
        [
          textInput("new-project-env-key", "Env key", model.new_project_form.env_key, (value) =>
            ChangedNewProjectEnvKey({ value }),
          ),
          textInput("new-project-env-value", "Env value", model.new_project_form.env_value, (value) =>
            ChangedNewProjectEnvValue({ value }),
          ),
        ],
      ),
      Ui.button(
        [
          H.Type("submit"),
          H.Disabled(
            model.new_project_form.name.trim().length === 0 || model.new_project_form.repo_origin.trim().length === 0,
          ),
        ],
        ["Create"],
      ),
    ],
  )

const projectDetailPanel = (model: Model): Html => {
  const project = model.selected_project
  if (project === undefined) {
    return Ui.Card.card({ class: "project-detail-card" }, [H.div([H.Class("empty-state")], ["Select a project"])])
  }
  return Ui.Card.card({ class: "project-detail-card" }, [
    H.div([H.Class("projects-section-header")], [H.h3([], [project.name]), Ui.badge(["details"], "success")]),
    H.form(
      [H.Class("project-form"), H.OnSubmit(SubmittedProjectSettings())],
      [
        textInput("project-name", "Name", model.project_form.name, (value) =>
          ChangedProjectField({ field: "name", value }),
        ),
        textInput("project-repo", "Repository", model.project_form.repo_origin, (value) =>
          ChangedProjectField({ field: "repo_origin", value }),
        ),
        textInput("project-branch", "Branch", model.project_form.default_branch, (value) =>
          ChangedProjectField({ field: "default_branch", value }),
        ),
        textInput("project-template", "Template", model.project_form.template_id, (value) =>
          ChangedProjectField({ field: "template_id", value }),
        ),
        envEditor(model),
        Ui.button([H.Type("submit")], ["Save"]),
      ],
    ),
    secretsPanel(model, project),
  ])
}

const envEditor = (model: Model): Html =>
  H.div(
    [H.Class("env-editor")],
    [
      H.h4([], ["Environment"]),
      ...Object.entries(model.project_form.env).map(([key, value]) =>
        H.div(
          [H.Key(key), H.Class("env-row")],
          [
            H.span([H.Class("env-key")], [key]),
            H.input([
              H.Type("text"),
              H.Value(value),
              H.AriaLabel(`${key} value`),
              H.OnInput((next) => ChangedProjectEnvValue({ key, value: next })),
            ]),
            Ui.button([H.Type("button"), H.OnClick(RemovedProjectEnv({ key }))], ["Remove"], "ghost"),
          ],
        ),
      ),
    ],
  )

const secretsPanel = (model: Model, project: NonNullable<Model["selected_project"]>): Html =>
  H.section(
    [H.Class("secrets-panel")],
    [
      H.h4([], ["Secrets"]),
      project.secret_names.length === 0
        ? H.div([H.Class("empty-state")], ["No secrets"])
        : H.div(
            [H.Class("secret-list")],
            project.secret_names.map((name) => secretRow(model, name)),
          ),
      H.form(
        [H.Class("secret-form"), H.OnSubmit(SubmittedProjectSecret())],
        [
          textInput("project-secret-name", "Secret name", model.project_secret_name, (value) =>
            ChangedProjectSecretField({ field: "name", value }),
          ),
          textInput(
            "project-secret-value",
            "Secret value",
            model.project_secret_value,
            (value) => ChangedProjectSecretField({ field: "value", value }),
            "password",
          ),
          Ui.button(
            [
              H.Type("submit"),
              H.Disabled(model.project_secret_name.trim().length === 0 || model.project_secret_value.length === 0),
            ],
            ["Set value"],
          ),
        ],
      ),
    ],
  )

const secretRow = (model: Model, name: string): Html =>
  H.div(
    [H.Key(name), H.Class("secret-row")],
    [
      H.span([H.Class("secret-name")], [name]),
      H.span([H.Class("secret-mask")], ["****"]),
      Ui.button([H.Type("button"), H.OnClick(ClickedDeleteProjectSecret({ name }))], ["Delete"], "ghost"),
    ],
  )

const deleteSecretDialog = (model: Model): Html =>
  H.submodel({
    slotId: model.delete_secret_dialog.id,
    model: model.delete_secret_dialog,
    view: Ui.AlertDialog.view,
    viewInputs: Ui.AlertDialog.content({}, () => [
      Ui.AlertDialog.header({}, [
        Ui.AlertDialog.title({ model: model.delete_secret_dialog }, ["Delete secret?"]),
        Ui.AlertDialog.description({ model: model.delete_secret_dialog }, [
          model.pending_secret_delete_name === undefined
            ? "This secret value will be removed from the selected project."
            : `Secret ${model.pending_secret_delete_name} will be removed from the selected project.`,
        ]),
      ]),
      Ui.AlertDialog.footer({}, [
        Ui.AlertDialog.cancel({ attributes: [H.Type("button"), H.OnClick(CancelledDeleteProjectSecret())] }, [
          "Cancel",
        ]),
        Ui.AlertDialog.action(
          { variant: "destructive", attributes: [H.Type("button"), H.OnClick(ConfirmedDeleteProjectSecret())] },
          ["Delete"],
        ),
      ]),
    ]),
    toParentMessage: (message) => GotDeleteSecretDialogMessage({ message }),
  })

const textInput = (
  id: string,
  label: string,
  value: string,
  onInput: (value: string) => AppMessage,
  type = "text",
): Html =>
  H.label(
    [H.Class("field")],
    [H.span([], [label]), H.input([H.Id(id), H.Type(type), H.Value(value), H.OnInput(onInput), H.AriaLabel(label)])],
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
  return H.section(
    [H.Class("orb-header")],
    [
      H.div(
        [H.Class("orb-status")],
        [
          Ui.badge([orb.status], orbBadgeTone(orb.status)),
          H.span([], [`last active ${relativeTime(orb.last_active_at)}`]),
          H.span([], [`runtime ${formatMinutes(orb.running_minutes)}m`]),
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
          Ui.button(
            [H.Type("button"), H.Disabled(orb.status === "killed"), H.OnClick(ClickedKillOrb())],
            ["Kill"],
            "danger",
          ),
        ],
      ),
    ],
  )
}

const killOrbDialog = (model: Model): Html =>
  model.selected_orb === undefined
    ? Ui.empty
    : H.submodel({
        slotId: model.kill_orb_dialog.id,
        model: model.kill_orb_dialog,
        view: Ui.AlertDialog.view,
        viewInputs: Ui.AlertDialog.content({}, () => [
          Ui.AlertDialog.header({}, [
            Ui.AlertDialog.title({ model: model.kill_orb_dialog }, ["Kill orb?"]),
            Ui.AlertDialog.description({ model: model.kill_orb_dialog }, [
              "The selected orb will stop and its running workspace session will end.",
            ]),
          ]),
          Ui.AlertDialog.footer({}, [
            Ui.AlertDialog.cancel({ attributes: [H.Type("button"), H.OnClick(CancelledKillOrb())] }, ["Cancel"]),
            Ui.AlertDialog.action(
              { variant: "destructive", attributes: [H.Type("button"), H.OnClick(ConfirmedKillOrb())] },
              ["Kill"],
            ),
          ]),
        ]),
        toParentMessage: (message) => GotKillOrbDialogMessage({ message }),
      })

const transcript = (model: Model): Html => {
  const rows = eventRows(
    model.events,
    new Set(model.expanded_diff_ids),
    model.user_id,
    new Set(model.collapsed_transcript_row_ids),
  )
  return Ui.Card.card({ class: "transcript-card" }, [
    Ui.Conversation.conversation({ class: "transcript-conversation" }, [
      Ui.Conversation.conversationContent(
        {
          model: model.transcript_scroller,
          toParentMessage: (message) => GotTranscriptScrollerMessage({ message }),
          class: "transcript-content",
        },
        rows.length === 0
          ? [
              Ui.MessageScroller.item({}, [
                Ui.Conversation.conversationEmptyState(
                  {
                    title: "No events yet",
                    description:
                      "Open a CLI thread or submit a turn. Events will appear here from the shared subscription.",
                  },
                  [],
                ),
              ]),
            ]
          : rows.map((row) => Ui.MessageScroller.item({ attributes: [H.Key(row.id)] }, [rowView(row)])),
      ),
      Ui.Conversation.conversationScrollButton({
        model: model.transcript_scroller,
        toParentMessage: (message) => GotTranscriptScrollerMessage({ message }),
      }),
    ]),
  ])
}

const presenceAvatars = (model: Model): Html =>
  model.presence.length === 0
    ? Ui.empty
    : H.div(
        [H.Class("presence-avatars"), H.AriaLabel("Present users")],
        model.presence.map((user) =>
          H.span([H.Class("presence-avatar"), H.Title(user.user_id)], [initials(user.user_id)]),
        ),
      )

const typingIndicator = (model: Model): Html => {
  const typing = model.presence.find((user) => user.state === "typing")
  return typing === undefined ? Ui.empty : H.div([H.Class("typing-indicator")], [`${typing.user_id} is typing`])
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
  if (tab === "files") return orbFilesPanel(model)
  if (tab === "changes") return orbChangesPanel(model)
  return orbTerminalPanel(model)
}

const orbTerminalPanel = (model: Model): Html =>
  Ui.Card.card({ class: "orb-terminal-card" }, [
    H.div(
      [H.Class("orb-terminal-toolbar")],
      [
        Ui.badge([model.orb_terminal_status], terminalStatusTone(model.orb_terminal_status)),
        model.orb_terminal_error === undefined
          ? Ui.empty
          : H.span([H.Class("orb-terminal-error")], [model.orb_terminal_error]),
        Ui.button(
          [
            H.Type("button"),
            H.Disabled(model.selected_thread_id === undefined),
            H.OnClick(RequestedTerminalReconnect()),
          ],
          ["Reconnect"],
          "ghost",
        ),
      ],
    ),
    model.selected_thread_id === undefined
      ? H.div([H.Class("empty-state")], ["No thread selected"])
      : H.div(
          [
            H.Key(orbTerminalKey(model.selected_thread_id)),
            H.Class("orb-terminal-mount"),
            H.DataAttribute("orb-terminal", ""),
            H.OnMount(MountOrbTerminal({ thread_id: model.selected_thread_id })),
          ],
          [],
        ),
  ])

const orbFilesPanel = (model: Model): Html =>
  Ui.Card.card({ class: "orb-files-card" }, [
    model.orb_files.paths.length === 0
      ? H.div([H.Class("empty-state")], [orbDirectoryStatus(model, "")])
      : H.div(
          [H.Class("orb-files-layout")],
          [
            H.div(
              [
                H.Key(orbTreeKey(model)),
                H.Class("orb-file-tree"),
                H.DataAttribute("pierre-tree", ""),
                H.OnMount(MountPierreTree(orbTreeMountArgs(model))),
              ],
              [],
            ),
            orbFileViewer(model),
          ],
        ),
  ])

const orbFileViewer = (model: Model): Html => {
  const opened = model.orb_files.opened_file
  if (opened.state === "idle") return H.div([H.Class("orb-file-viewer empty-state")], ["Select a file"])
  if (opened.state === "loading") return H.div([H.Class("orb-file-viewer empty-state")], [`Loading ${opened.path}`])
  if (opened.state === "binary") return H.div([H.Class("orb-file-viewer empty-state")], [`${opened.path} is binary`])
  if (opened.state === "failed") return H.div([H.Class("orb-file-viewer empty-state")], [opened.message])
  return H.div(
    [H.Class("orb-file-viewer")],
    [
      H.div(
        [H.Class("orb-file-viewer-header")],
        [H.strong([], [opened.path]), opened.truncated ? Ui.badge(["truncated"], "warning") : Ui.empty],
      ),
      H.pre([H.Class("orb-file-content")], [opened.content]),
    ],
  )
}

const orbChangesPanel = (model: Model): Html => {
  const changes = model.orb_changes
  if (changes.state === "idle")
    return Ui.Card.card({ class: "orb-changes-card" }, [H.div([H.Class("empty-state")], ["Changes not loaded"])])
  if (changes.state === "loading")
    return Ui.Card.card({ class: "orb-changes-card" }, [H.div([H.Class("empty-state")], ["Loading changes"])])
  if (changes.state === "failed")
    return Ui.Card.card({ class: "orb-changes-card" }, [H.div([H.Class("empty-state")], [changes.message])])
  return Ui.Card.card({ class: "orb-changes-card" }, [
    H.div(
      [H.Class("orb-changes-summary")],
      [
        Ui.badge([changes.dirty ? "dirty" : "clean"], changes.dirty ? "warning" : "success"),
        H.span([], [`base ${shortId(changes.base_commit)}`]),
        H.span([], [`head ${shortId(changes.head_commit)}`]),
      ],
    ),
    changes.diffs.length === 0
      ? H.div([H.Class("empty-state")], [changes.dirty ? "No renderable file diffs" : "Workspace clean"])
      : H.div([H.Class("orb-change-list")], changes.diffs.map(orbChangeRowView)),
  ])
}

const orbChangeRowView = (row: Extract<Model["orb_changes"], { readonly state: "loaded" }>["diffs"][number]): Html =>
  row.kind === "diff" ? orbChangeDiffView(row) : orbChangeSkippedView(row)

const orbChangeSkippedView = (
  row: Extract<Model["orb_changes"], { readonly state: "loaded" }>["diffs"][number] & { readonly kind: "skipped" },
): Html =>
  H.article(
    [H.Key(row.payload_id), H.Class("event-row event-row-diff")],
    [
      H.div(
        [H.Class("event-meta")],
        [H.strong([], [row.file_name]), Ui.badge(["skipped"], "warning"), H.span([], [row.reason])],
      ),
    ],
  )

const orbChangeDiffView = (
  diff: Extract<Model["orb_changes"], { readonly state: "loaded" }>["diffs"][number] & { readonly kind: "diff" },
): Html =>
  H.article(
    [H.Key(diff.payload_id), H.Class("event-row event-row-diff")],
    [
      H.div(
        [H.Class("event-meta")],
        [
          H.strong([], [diff.file_name]),
          H.span([H.Class("diff-stat diff-stat-add")], [`+${diff.additions}`]),
          H.span([H.Class("diff-stat diff-stat-delete")], [`-${diff.deletions}`]),
        ],
      ),
      H.div(
        [
          H.Class("pierre-diff-mount"),
          H.DataAttribute("orb-change-diff-id", diff.payload_id),
          H.OnMount(
            MountPierreDiff({
              payload_id: diff.payload_id,
              file_diff: diff.file_diff,
              theme_type: "dark",
            }),
          ),
        ],
        [],
      ),
    ],
  )

const rowView = (row: TranscriptRow): Html => (row.kind === "pierre-diff" ? pierreDiffRowView(row) : textRowView(row))

const textRowView = (row: Exclude<TranscriptRow, { readonly kind: "pierre-diff" }>): Html =>
  row.kind === "message"
    ? messageRowView(row)
    : row.kind === "tool"
      ? toolRowView(row, false)
      : row.kind === "error" && row.title.startsWith("Tool:")
        ? toolRowView(row, true)
        : row.title === "Reasoning"
          ? reasoningRowView(row)
          : eventRowView(row)

const messageRowView = (row: Exclude<TranscriptRow, { readonly kind: "pierre-diff" }>): Html => {
  const localUser = row.author?.is_local ?? row.title === "User"
  const sender = row.author?.label ?? row.title
  const align = localUser ? "end" : "start"
  const variant = row.title === "Rika" ? "secondary" : localUser ? "default" : "muted"
  return Ui.Message.message({ align, attributes: [H.DataAttribute("transcript-row-kind", "message")] }, [
    Ui.Message.messageAvatar({}, [
      Ui.Avatar.avatar({ size: "sm" }, [Ui.Avatar.avatarFallback({}, [messageInitial(row)])]),
    ]),
    Ui.Message.messageContent({}, [
      Ui.Message.messageHeader({}, [H.span([], [`#${row.sequence}`]), H.strong([], [sender])]),
      Ui.Bubble.bubble({ align, variant }, [Ui.Bubble.bubbleContent({}, markdownContent(row.body))]),
    ]),
  ])
}

const reasoningRowView = (row: Exclude<TranscriptRow, { readonly kind: "pierre-diff" }>): Html => {
  const isOpen = row.is_open ?? true
  return Ui.Reasoning.reasoning({ isOpen, attributes: [H.DataAttribute("transcript-row-kind", "reasoning")] }, [
    Ui.Reasoning.reasoningTrigger(
      {
        isOpen,
        onToggled: ClickedTranscriptDisclosure({ row_id: row.id }),
        attributes: [H.DataAttribute("sequence", String(row.sequence))],
      },
      [],
    ),
    isOpen ? Ui.Reasoning.reasoningContent({}, markdownContent(row.body)) : Ui.empty,
  ])
}

const toolRowView = (row: Exclude<TranscriptRow, { readonly kind: "pierre-diff" }>, isError: boolean): Html => {
  const isOpen = row.is_open ?? true
  return Ui.Tool.tool({ attributes: [H.DataAttribute("transcript-row-kind", isError ? "tool-error" : "tool")] }, [
    Ui.Tool.toolHeader({
      name: toolName(row.title),
      status: isError ? "output-error" : toolStatus(row.body),
      isOpen,
      onToggled: ClickedTranscriptDisclosure({ row_id: row.id }),
    }),
    isOpen
      ? Ui.Tool.toolContent({}, [
          Ui.Tool.toolOutput({ isError }, [codeBlock("text", row.body, isError ? "error" : "output")]),
        ])
      : Ui.empty,
  ])
}

const eventRowView = (row: Exclude<TranscriptRow, { readonly kind: "pierre-diff" }>): Html =>
  H.article(
    [
      H.Class(
        Ui.cn("event-row", row.kind === "message" && "event-row-message", row.kind === "error" && "event-row-error"),
      ),
      H.DataAttribute("transcript-row-kind", row.kind),
    ],
    [
      H.div([H.Class("event-meta")], [H.span([], [`#${row.sequence}`]), H.strong([], [row.title])]),
      H.p([H.Class("event-body")], [row.body]),
    ],
  )

const toolName = (title: string): string => title.replace(/^Tool input:\s*/, "").replace(/^Tool:\s*/, "")

const toolStatus = (body: string): Ui.Tool.ToolStatus =>
  body === "Running" || body === "Started" ? "input-available" : "output-available"

const messageInitial = (row: Exclude<TranscriptRow, { readonly kind: "pierre-diff" }>): string => {
  const sender = row.author?.label ?? row.title
  return initials(sender)
}

const pierreDiffRowView = (row: Extract<TranscriptRow, { readonly kind: "pierre-diff" }>): Html =>
  H.article(
    [H.Key(row.id), H.Class("event-row event-row-diff")],
    [
      H.div(
        [H.Class("event-meta")],
        [
          H.span([], [`#${row.sequence}`]),
          H.strong([], [row.title]),
          H.span([H.Class("diff-stat diff-stat-add")], [`+${row.diff.additions}`]),
          H.span([H.Class("diff-stat diff-stat-delete")], [`-${row.diff.deletions}`]),
        ],
      ),
      H.div(
        [H.Class("pierre-diff-summary")],
        [
          H.span([H.Class("pierre-diff-file")], [row.diff.file_name]),
          Ui.button(
            [H.Type("button"), H.OnClick(ClickedTogglePierreDiff({ payload_id: row.diff.payload_id }))],
            [row.expanded ? "Hide diff" : "Show diff"],
            "ghost",
          ),
        ],
      ),
      row.expanded
        ? H.div(
            [
              H.Class("pierre-diff-mount"),
              H.DataAttribute("pierre-diff-id", row.diff.payload_id),
              H.OnMount(
                MountPierreDiff({
                  payload_id: row.diff.payload_id,
                  file_diff: row.diff.file_diff,
                  theme_type: "dark",
                }),
              ),
            ],
            [],
          )
        : Ui.empty,
    ],
  )

const composer = (model: Model): Html => {
  const active = activeTurnId(model.events)
  return Ui.PromptInput.promptInput({ class: "composer", onSubmitted: SubmittedDraft() }, [
    Ui.PromptInput.promptInputTextarea({
      id: "turn-input",
      value: model.draft,
      onInput: (value) => ChangedDraft({ value }),
      placeholder: model.selected_thread_id === undefined ? "Start a new Rika thread" : "Send a turn to this thread",
      rows: 3,
      attributes: [H.AriaLabel("Turn input")],
    }),
    Ui.PromptInput.promptInputToolbar({ class: "composer-footer" }, [
      H.span(
        [H.Class("muted")],
        [model.pending_turn ? "Waiting for the shared event stream" : "Rendered only from durable thread events"],
      ),
      Ui.PromptInput.promptInputTools({ class: "composer-controls" }, [
        Ui.select({
          id: "turn-mode",
          value: model.draft_mode ?? "",
          options: modeOptions,
          onChange: (value) => ChangedDraftMode({ value }),
          attributes: [H.AriaLabel("Mode")],
          class: "mode-select",
        }),
        active === undefined
          ? Ui.empty
          : Ui.PromptInput.promptInputButton(
              {
                type: "button",
                variant: "destructive",
                disabled: model.pending_interrupt_turn_id === active,
                onClick: ClickedInterrupt(),
              },
              ["Stop"],
            ),
        Ui.PromptInput.promptInputSubmit(
          {
            type: "submit",
            disabled: model.draft.trim().length === 0 || model.pending_turn || active !== undefined,
            status: model.pending_turn || active !== undefined ? "submitted" : "idle",
          },
          [model.pending_turn || active !== undefined ? "Running" : "Send"],
        ),
      ]),
    ]),
  ])
}

const activeTitle = (model: Model) => {
  if (model.active_view === "projects") return "Projects"
  const thread = model.threads.find((item) => item.thread_id === model.selected_thread_id)
  return (
    thread?.title_text ??
    (model.selected_thread_id === undefined ? "No thread selected" : shortId(model.selected_thread_id))
  )
}

const orbTreeMountArgs = (model: Model) => {
  const selected = selectedTreePath(model)
  return {
    mount_key:
      model.selected_thread_id === undefined || model.selected_orb === undefined
        ? "orb-tree:unmounted"
        : pierreTreeMountKey(model.selected_thread_id, model.selected_orb.orb_id),
    paths: model.orb_files.paths,
    git_status: model.orb_files.git_status,
    ...(selected === undefined ? {} : { selected_path: selected }),
  }
}

const selectedTreePath = (model: Model) => {
  const selected = model.orb_files.selected_path
  if (selected === undefined) return undefined
  return model.orb_files.path_kinds[selected] === "dir" ? `${selected}/` : selected
}

const orbTreeKey = (model: Model) =>
  model.selected_thread_id === undefined || model.selected_orb === undefined
    ? "orb-tree:unmounted"
    : pierreTreeMountKey(model.selected_thread_id, model.selected_orb.orb_id)

const orbTerminalKey = (thread_id: NonNullable<Model["selected_thread_id"]>) => `orb-terminal:${thread_id}`

const orbDirectoryStatus = (model: Model, path: string) => {
  const status = model.orb_files.directories[path]
  if (status?.state === "loading") return "Loading files"
  if (status?.state === "failed") return status.message
  return "No files loaded"
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

const terminalStatusTone = (status: Model["orb_terminal_status"]) => {
  if (status === "connected") return "success"
  if (status === "connecting") return "warning"
  if (status === "failed" || status === "disconnected") return "danger"
  return "default"
}

const initials = (value: string) =>
  value
    .split(/[_\s-]+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || value.slice(0, 1).toUpperCase()

const relativeTime = (timestamp: number) => {
  const delta = Date.now() - timestamp
  if (delta < 60_000) return "just now"
  const minutes = Math.max(1, Math.floor(delta / 60_000))
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

const formatMinutes = (minutes: number) => {
  if (Number.isInteger(minutes)) return String(minutes)
  return minutes.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")
}

const shortId = (value: string) => (value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`)
