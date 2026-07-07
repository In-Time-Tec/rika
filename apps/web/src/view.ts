import { html, type Document, type Html } from "foldkit/html"
import {
  activeTurnId,
  CancelledKillOrb,
  ChangedDraft,
  ChangedDraftMode,
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
  ClickedToggleTheme,
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
  eventRows,
  OrbTabItems,
  pierreTreeMountKey,
  type AppMessage,
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
const svgIcon = (className: string, paths: ReadonlyArray<string>): Html =>
  H.svg(
    [
      H.Attribute("xmlns", "http://www.w3.org/2000/svg"),
      H.Attribute("viewBox", "0 0 24 24"),
      H.Attribute("fill", "none"),
      H.Attribute("stroke", "currentColor"),
      H.Attribute("stroke-width", "1.75"),
      H.Attribute("stroke-linecap", "round"),
      H.Attribute("stroke-linejoin", "round"),
      H.AriaHidden(true),
      H.Class(className),
    ],
    paths.map((d) => H.path([H.Attribute("d", d)], [])),
  )

const iconSearch = (c: string) => svgIcon(c, ["m21 21-4.35-4.35", "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z"])
const iconFilter = (c: string) => svgIcon(c, ["M3 6h18", "M7 12h10", "M10 18h4"])
const iconCompose = (c: string) =>
  svgIcon(c, [
    "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7",
    "M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z",
  ])
const iconMonitor = (c: string) =>
  svgIcon(c, ["M3 4h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z", "M8 20h8", "M12 16v4"])
const iconActivity = (c: string) =>
  svgIcon(c, [
    "M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2",
    "M18 14h-8",
    "M15 18h-5",
    "M10 6h8v4h-8V6Z",
  ])
const iconFolder = (c: string) =>
  svgIcon(c, [
    "M20 17a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3.9a2 2 0 0 1-1.69-.9l-.81-1.2a2 2 0 0 0-1.67-.9H8a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2Z",
    "M2 8v11a2 2 0 0 0 2 2h14",
  ])
const iconChevrons = (c: string) => svgIcon(c, ["m7 15 5 5 5-5", "m7 9 5-5 5 5"])
const iconPanel = (c: string) =>
  svgIcon(c, ["M3 4h18a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z", "M9 4v16"])
const iconImage = (c: string) =>
  svgIcon(c, [
    "M16 5h6",
    "M19 2v6",
    "M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5",
    "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21",
    "M9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  ])
const iconPlugOff = (c: string) => svgIcon(c, ["M2 2l20 20", "M9 9v3a3 3 0 0 0 3 3", "M15 6.5V4a2 2 0 0 0-4 0v.5"])
const iconMore = (c: string) =>
  H.svg(
    [
      H.Attribute("xmlns", "http://www.w3.org/2000/svg"),
      H.Attribute("viewBox", "0 0 24 24"),
      H.Attribute("fill", "none"),
      H.Attribute("stroke", "currentColor"),
      H.Attribute("stroke-width", "3"),
      H.Attribute("stroke-linecap", "round"),
      H.Attribute("stroke-linejoin", "round"),
      H.AriaHidden(true),
      H.Class(c),
    ],
    ["M5 12h.01", "M12 12h.01", "M19 12h.01"].map((d) => H.path([H.Attribute("d", d)], [])),
  )

const projectTag = (thread: Model["threads"][number]): string => {
  const segments = String(thread.workspace_id).split("/").filter(Boolean)
  return segments[segments.length - 1] ?? ""
}

const compactAge = (timestamp: number): string => {
  const delta = Date.now() - timestamp
  const mins = Math.floor(delta / 60_000)
  if (mins < 1) return "now"
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

const iconButton = (label: string, icon: Html, message: AppMessage, primary = false): Html =>
  H.button(
    [
      H.Type("button"),
      H.Class(
        Ui.cn(
          "grid size-7 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          primary && "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground",
        ),
      ),
      H.AriaLabel(label),
      H.Attribute("title", label),
      H.OnClick(message),
    ],
    [icon],
  )

const threadActionsButton = (): Html =>
  H.button(
    [
      H.Type("button"),
      H.Class(
        "grid size-6 shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-muted-foreground hover:bg-accent",
      ),
      H.AriaLabel("Thread actions"),
    ],
    [iconMore("size-4")],
  )

const accountLabel = (model: Model): string => (model.user_id === undefined ? "Rika" : String(model.user_id))

const footerItemClass =
  "flex h-8 w-full cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent p-2 text-left text-[13px] font-medium text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"

const noticeClass = "rounded-lg border border-destructive/40 bg-destructive/15 px-3.5 py-3 text-destructive"
const emptyStateClass = "grid min-h-[18rem] place-items-center text-center text-muted-foreground"
const emptyStateCompactClass = "grid min-h-20 place-items-center text-center text-muted-foreground"
const sectionHeaderClass = "flex items-center justify-between gap-3"
const formGridClass = "grid content-start gap-3"
const inputClass =
  "min-h-10 w-full min-w-0 rounded-lg border border-input bg-[color-mix(in_oklch,var(--background),var(--input)_18%)] px-3 py-[0.55rem] text-foreground outline-none focus:border-ring focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--ring),transparent_58%)]"
const compactButtonsClass = "[&_[data-slot=button]]:h-8 [&_[data-slot=button]]:px-[0.7rem]"
const eventRowClass = "grid gap-[0.45rem] border-b border-[color:var(--border-subtle)] p-3.5 last:border-b-0"
const eventRowDiffClass = `${eventRowClass} border-l-[3px] border-l-[color:var(--info)]`
const eventMetaClass =
  "flex flex-wrap items-center gap-[0.55rem] text-xs text-muted-foreground [&_strong]:text-foreground"
const monoTextClass = "font-mono text-[13px] [overflow-wrap:anywhere]"
const pierreDiffMountClass = "max-w-full overflow-auto rounded-lg border border-border bg-background"
const bareCardClass = "min-h-0 overflow-hidden p-0"
const panelSectionHeaderClass = "flex items-center gap-3 border-b border-[color:var(--border-subtle)] p-3"
const diffStatAddClass = "font-extrabold text-[color:var(--success)]"
const diffStatDeleteClass = "font-extrabold text-destructive"
const orbFileViewerEmptyClass = Ui.cn(emptyStateClass, "min-h-[28rem] min-w-0 overflow-auto")

const sidebarFooter = (model: Model): Html =>
  H.div(
    [H.Class("mt-auto flex flex-col gap-0.5 border-t border-sidebar-border pt-2")],
    [
      H.button(
        [H.Type("button"), H.Class(footerItemClass), H.OnClick(ClickedThreads())],
        [iconActivity("size-4 shrink-0"), H.span([H.Class("truncate")], ["Activity"])],
      ),
      H.button(
        [H.Type("button"), H.Class(footerItemClass), H.OnClick(ClickedProjects())],
        [iconFolder("size-4 shrink-0"), H.span([H.Class("truncate")], ["Projects"])],
      ),
      H.button(
        [
          H.Type("button"),
          H.Class(footerItemClass),
          H.OnClick(ClickedToggleTheme()),
          H.Attribute("title", "Toggle theme"),
        ],
        [
          H.span(
            [
              H.Class(
                "grid size-5 shrink-0 place-items-center rounded-full bg-[oklch(0.55_0.2_12)] text-[10px] font-bold text-white",
              ),
            ],
            [initials(accountLabel(model))],
          ),
          H.span([H.Class("min-w-0 flex-1 truncate")], [accountLabel(model)]),
          iconChevrons("size-3 shrink-0"),
        ],
      ),
    ],
  )

const connectionStatus = (model: Model): Html =>
  model.connection === "connected"
    ? Ui.empty
    : H.span(
        [H.Class("inline-flex items-center gap-1.5 text-[13px] text-muted-foreground")],
        [iconPlugOff("size-3.5 shrink-0"), "Not Connected"],
      )

export const view = (model: Model): Document => ({
  title: model.selected_thread_id === undefined ? "Rika" : `Rika · ${shortId(model.selected_thread_id)}`,
  body: H.main(
    [
      H.Class(
        Ui.cn(
          model.theme === "dark" && "dark",
          "box-border flex h-dvh overflow-hidden bg-background p-[13px] text-foreground",
        ),
      ),
    ],
    [
      H.div(
        [H.Class("grid min-w-0 flex-1 grid-cols-[256px_minmax(0,1fr)] overflow-hidden rounded-md bg-card")],
        [sidebar(model), workspace(model)],
      ),
    ],
  ),
})

const sidebar = (model: Model): Html =>
  H.aside(
    [H.Class("flex min-h-0 flex-col gap-2 border-r border-border/60 px-2 py-1.5")],
    [
      H.div(
        [H.Class("-mx-2 flex items-center justify-between gap-2 border-b border-border/60 px-3 pt-1 pb-2")],
        [
          H.span([H.Class("text-[15px] font-semibold tracking-tight text-foreground")], ["Rika"]),
          H.div(
            [H.Class("flex items-center gap-0.5")],
            [
              iconButton("Search threads", iconSearch("size-4"), ClickedThreads()),
              iconButton("Filter", iconFilter("size-4"), ClickedThreads()),
              iconButton("New thread", iconCompose("size-4"), ClickedNewThread(), true),
            ],
          ),
        ],
      ),
      H.nav(
        [H.Class("flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto"), H.AriaLabel("Threads")],
        model.threads.length === 0
          ? [H.p([H.Class("m-0 px-2 py-1.5 text-xs text-muted-foreground")], ["No threads yet"])]
          : threadListChildren(model),
      ),
      sidebarFooter(model),
    ],
  )

const threadGroupHeader = (label: string): Html =>
  H.p(
    [
      H.Class(
        "mx-0 mt-1.5 mb-0.5 flex h-5 shrink-0 items-center gap-2 px-2 text-[10px] font-normal text-muted-foreground/50 after:flex-1 after:border-t after:border-border after:content-['']",
      ),
    ],
    [label],
  )

const threadListChildren = (model: Model): ReadonlyArray<Html> => {
  const cutoff = Date.now() - 86_400_000
  const recent = model.threads.filter((thread) => thread.updated_at >= cutoff)
  const inactive = model.threads.filter((thread) => thread.updated_at < cutoff)
  return [
    ...(recent.length === 0 ? [] : [threadGroupHeader("Recent"), ...recent.map((t) => threadButton(model, t))]),
    ...(inactive.length === 0
      ? []
      : [threadGroupHeader("Inactive Last 24h"), ...inactive.map((t) => threadButton(model, t))]),
  ]
}

const threadButton = (model: Model, thread: Model["threads"][number]): Html =>
  H.button(
    [
      H.Class(
        Ui.cn(
          "flex h-8 w-full cursor-pointer items-center gap-[5px] rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          model.selected_thread_id === thread.thread_id && "bg-sidebar-accent text-sidebar-accent-foreground",
        ),
      ),
      H.OnClick(ClickedThread({ thread_id: thread.thread_id })),
    ],
    [
      iconMonitor("size-3.5 shrink-0"),
      H.span(
        [H.Class("min-w-0 flex-1 truncate text-xs font-medium")],
        [thread.title_text ?? shortId(thread.thread_id)],
      ),
      H.span([H.Class("shrink-0 text-[10px]")], [projectTag(thread)]),
      H.span([H.Class("shrink-0 text-[10px]")], [compactAge(thread.updated_at)]),
    ],
  )

const workspace = (model: Model): Html =>
  H.section(
    [H.Class("grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-3 px-4 py-3")],
    [
      H.header(
        [H.Class("flex items-center justify-between gap-3")],
        [
          H.div(
            [H.Class("flex min-w-0 items-center gap-2.5")],
            [
              iconPanel("size-4 shrink-0 text-muted-foreground"),
              model.selected_thread_id === undefined && model.active_view !== "projects"
                ? Ui.empty
                : H.h2([H.Class("m-0 truncate text-[15px] font-semibold")], [activeTitle(model)]),
              model.selected_thread_id === undefined ? Ui.empty : threadActionsButton(),
              presenceAvatars(model),
            ],
          ),
          H.div(
            [H.Class("flex items-center gap-3 text-[13px] text-muted-foreground")],
            [
              model.selected_thread_id === undefined
                ? Ui.empty
                : H.span(
                    [H.Class("inline-flex items-center gap-1")],
                    [iconFolder("size-3.5 shrink-0"), selectedThreadProject(model)],
                  ),
              model.selected_thread_id === undefined ? Ui.empty : H.span([], [model.draft_mode ?? "smart"]),
            ],
          ),
        ],
      ),
      model.active_view === "projects"
        ? projectsWorkspace(model)
        : H.div(
            [H.Class("grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-3")],
            [
              orbHeader(model),
              killOrbDialog(model),
              model.notice === undefined ? Ui.empty : H.div([H.Class(noticeClass)], [model.notice]),
              hasOrbWorkspace(model) ? orbTabs(model) : transcript(model),
              typingIndicator(model),
              model.selected_thread_id === undefined ? Ui.empty : composer(model),
            ],
          ),
    ],
  )

const projectsWorkspace = (model: Model): Html =>
  H.div(
    [H.Class("grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] gap-4")],
    [
      model.notice === undefined ? Ui.empty : H.div([H.Class(noticeClass)], [model.notice]),
      deleteSecretDialog(model),
      H.div(
        [H.Class("grid min-h-0 grid-cols-[minmax(16rem,24rem)_minmax(0,1fr)] gap-4 max-[820px]:grid-cols-1")],
        [projectsListPanel(model), projectDetailPanel(model)],
      ),
    ],
  )

const projectsListPanel = (model: Model): Html =>
  Ui.Card.card({ class: "grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-3.5 overflow-auto p-[0.9rem]" }, [
    H.div([H.Class(sectionHeaderClass)], [H.h3([H.Class("m-0")], ["Projects"])]),
    model.projects.length === 0
      ? H.div([H.Class(emptyStateCompactClass)], ["No projects"])
      : H.div(
          [H.Class("grid min-h-0 content-start gap-2 overflow-auto")],
          model.projects.map((project) => projectListButton(model, project)),
        ),
    newProjectForm(model),
  ])

const projectListButton = (model: Model, project: Model["projects"][number]): Html =>
  H.button(
    [
      H.Type("button"),
      H.Class(
        Ui.cn(
          "grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-[0.45rem] gap-y-1 rounded-lg border border-transparent bg-transparent p-3 text-left hover:border-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          model.selected_project_id === project.project_id &&
            "border-ring bg-sidebar-accent text-sidebar-accent-foreground",
        ),
      ),
      H.OnClick(ClickedProject({ project_id: project.project_id })),
    ],
    [
      H.span([H.Class("col-span-full min-w-0 truncate font-extrabold")], [project.name]),
      H.span([H.Class("min-w-0 truncate text-[13px] text-muted-foreground")], [project.repo_origin]),
      project.env_keys.length === 0 ? Ui.empty : Ui.badge([`${project.env_keys.length} env`], "default"),
      project.secret_names.length === 0 ? Ui.empty : Ui.badge([`${project.secret_names.length} secrets`], "warning"),
    ],
  )

const newProjectForm = (model: Model): Html =>
  H.form(
    [
      H.Class(Ui.cn(formGridClass, "border-t border-[color:var(--border-subtle)] pt-3.5")),
      H.OnSubmit(SubmittedNewProject()),
    ],
    [
      H.h3([H.Class("m-0")], ["New project"]),
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
        [H.Class("grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 max-[820px]:grid-cols-1")],
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

const projectDetailCardClass = "grid min-h-0 content-start gap-3 overflow-auto p-[0.9rem]"

const projectDetailPanel = (model: Model): Html => {
  const project = model.selected_project
  if (project === undefined) {
    return Ui.Card.card({ class: projectDetailCardClass }, [H.div([H.Class(emptyStateClass)], ["Select a project"])])
  }
  return Ui.Card.card({ class: projectDetailCardClass }, [
    H.div([H.Class(sectionHeaderClass)], [H.h3([H.Class("m-0")], [project.name]), Ui.badge(["details"], "success")]),
    H.form(
      [H.Class(formGridClass), H.OnSubmit(SubmittedProjectSettings())],
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
    [H.Class(formGridClass)],
    [
      H.h4([H.Class("m-0")], ["Environment"]),
      ...Object.entries(model.project_form.env).map(([key, value]) =>
        H.div(
          [
            H.Key(key),
            H.Class(
              Ui.cn(
                "grid grid-cols-[minmax(8rem,14rem)_minmax(0,1fr)_auto] items-center gap-2 max-[820px]:grid-cols-1",
                compactButtonsClass,
              ),
            ),
          ],
          [
            H.span([H.Class(Ui.cn(monoTextClass, "min-w-0 text-foreground"))], [key]),
            H.input([
              H.Type("text"),
              H.Value(value),
              H.Class(inputClass),
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
    [H.Class(Ui.cn(formGridClass, "border-t border-[color:var(--border-subtle)] pt-4"))],
    [
      H.h4([H.Class("m-0")], ["Secrets"]),
      project.secret_names.length === 0
        ? H.div([H.Class(emptyStateCompactClass)], ["No secrets"])
        : H.div(
            [H.Class(formGridClass)],
            project.secret_names.map((name) => secretRow(model, name)),
          ),
      H.form(
        [H.Class(formGridClass), H.OnSubmit(SubmittedProjectSecret())],
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
    [
      H.Key(name),
      H.Class(
        Ui.cn(
          "grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--panel-muted)] p-2.5",
          compactButtonsClass,
        ),
      ),
    ],
    [
      H.span([H.Class(Ui.cn(monoTextClass, "min-w-0 text-foreground"))], [name]),
      H.span([H.Class(Ui.cn(monoTextClass, "text-muted-foreground"))], ["****"]),
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
    [H.Class("grid min-w-0 gap-1.5 text-[13px] font-bold text-muted-foreground")],
    [
      H.span([], [label]),
      H.input([H.Id(id), H.Type(type), H.Value(value), H.Class(inputClass), H.OnInput(onInput), H.AriaLabel(label)]),
    ],
  )

const selectedThreadProject = (model: Model): string => {
  const thread = model.threads.find((item) => item.thread_id === model.selected_thread_id)
  return thread === undefined ? "" : projectTag(thread)
}

const orbHeader = (model: Model): Html => {
  const orb = model.selected_orb
  if (orb === undefined) return Ui.empty
  return H.section(
    [
      H.Class(
        "flex items-center justify-between gap-3 rounded-lg border border-border bg-[color:var(--panel)] p-3 max-[820px]:flex-col max-[820px]:items-start",
      ),
    ],
    [
      H.div(
        [H.Class("flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground")],
        [
          Ui.badge([orb.status], orbBadgeTone(orb.status)),
          H.span([], [`last active ${relativeTime(orb.last_active_at)}`]),
          H.span([], [`runtime ${formatMinutes(orb.running_minutes)}m`]),
          H.span([], [orb.base_commit === null ? "base pending" : `base ${shortId(orb.base_commit)}`]),
        ],
      ),
      H.div(
        [H.Class(Ui.cn("flex flex-wrap items-center gap-2", compactButtonsClass))],
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
  if (rows.length === 0) {
    return H.div(
      [H.Class("grid h-full min-h-0 w-full place-items-center")],
      [H.span([H.Class("select-none text-[13rem] font-extrabold tracking-tighter text-foreground/[0.05]")], ["Rika"])],
    )
  }
  return Ui.Card.card({ class: "min-h-0 overflow-hidden border-0 bg-transparent p-0 shadow-none" }, [
    Ui.Conversation.conversation({ class: "min-h-0" }, [
      Ui.Conversation.conversationContent(
        {
          model: model.transcript_scroller,
          toParentMessage: (message) => GotTranscriptScrollerMessage({ message }),
          class: "gap-4 p-3",
        },
        rows.map((row) => Ui.MessageScroller.item({ attributes: [H.Key(row.id)] }, [rowView(row)])),
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
        [H.Class("flex flex-wrap items-center gap-2"), H.AriaLabel("Present users")],
        model.presence.map((user) =>
          H.span(
            [
              H.Class(
                "grid size-7 place-items-center rounded-full border border-ring bg-[color-mix(in_oklch,var(--ring),transparent_82%)] text-[0.7rem] font-extrabold text-foreground",
              ),
              H.Title(user.user_id),
            ],
            [initials(user.user_id)],
          ),
        ),
      )

const typingIndicator = (model: Model): Html => {
  const typing = model.presence.find((user) => user.state === "typing")
  return typing === undefined
    ? Ui.empty
    : H.div([H.Class("text-[13px] text-muted-foreground")], [`${typing.user_id} is typing`])
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
  Ui.Card.card({ class: "grid min-h-[28rem] grid-rows-[auto_minmax(0,1fr)] overflow-hidden p-0" }, [
    H.div(
      [H.Class(Ui.cn(panelSectionHeaderClass, compactButtonsClass))],
      [
        Ui.badge([model.orb_terminal_status], terminalStatusTone(model.orb_terminal_status)),
        model.orb_terminal_error === undefined
          ? Ui.empty
          : H.span(
              [H.Class("min-w-0 flex-1 text-[13px] text-destructive [overflow-wrap:anywhere]")],
              [model.orb_terminal_error],
            ),
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
      ? H.div([H.Class(emptyStateClass)], ["No thread selected"])
      : H.div(
          [
            H.Key(orbTerminalKey(model.selected_thread_id)),
            H.Class("min-h-0 min-w-0 max-w-full overflow-hidden rounded-lg bg-background"),
            H.DataAttribute("orb-terminal", ""),
            H.OnMount(MountOrbTerminal({ thread_id: model.selected_thread_id })),
          ],
          [],
        ),
  ])

const orbFilesPanel = (model: Model): Html =>
  Ui.Card.card({ class: bareCardClass }, [
    model.orb_files.paths.length === 0
      ? H.div([H.Class(emptyStateClass)], [orbDirectoryStatus(model, "")])
      : H.div(
          [H.Class("grid min-h-[28rem] grid-cols-[minmax(14rem,20rem)_minmax(0,1fr)] max-[820px]:grid-cols-1")],
          [
            H.div(
              [
                H.Key(orbTreeKey(model)),
                H.Class(
                  "min-w-0 overflow-auto border-r border-[color:var(--border-subtle)] p-3 max-[820px]:max-h-64 max-[820px]:border-r-0 max-[820px]:border-b",
                ),
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
  if (opened.state === "idle") return H.div([H.Class(orbFileViewerEmptyClass)], ["Select a file"])
  if (opened.state === "loading") return H.div([H.Class(orbFileViewerEmptyClass)], [`Loading ${opened.path}`])
  if (opened.state === "binary") return H.div([H.Class(orbFileViewerEmptyClass)], [`${opened.path} is binary`])
  if (opened.state === "failed") return H.div([H.Class(orbFileViewerEmptyClass)], [opened.message])
  return H.div(
    [H.Class("min-w-0 overflow-auto")],
    [
      H.div(
        [H.Class(panelSectionHeaderClass)],
        [
          H.strong([H.Class(monoTextClass)], [opened.path]),
          opened.truncated ? Ui.badge(["truncated"], "warning") : Ui.empty,
        ],
      ),
      H.pre(
        [
          H.Class(
            Ui.cn(monoTextClass, "m-0 overflow-auto p-[0.9rem] leading-normal whitespace-pre-wrap text-foreground"),
          ),
        ],
        [opened.content],
      ),
    ],
  )
}

const orbChangesPanel = (model: Model): Html => {
  const changes = model.orb_changes
  if (changes.state === "idle")
    return Ui.Card.card({ class: bareCardClass }, [H.div([H.Class(emptyStateClass)], ["Changes not loaded"])])
  if (changes.state === "loading")
    return Ui.Card.card({ class: bareCardClass }, [H.div([H.Class(emptyStateClass)], ["Loading changes"])])
  if (changes.state === "failed")
    return Ui.Card.card({ class: bareCardClass }, [H.div([H.Class(emptyStateClass)], [changes.message])])
  return Ui.Card.card({ class: bareCardClass }, [
    H.div(
      [H.Class(panelSectionHeaderClass)],
      [
        Ui.badge([changes.dirty ? "dirty" : "clean"], changes.dirty ? "warning" : "success"),
        H.span([], [`base ${shortId(changes.base_commit)}`]),
        H.span([], [`head ${shortId(changes.head_commit)}`]),
      ],
    ),
    changes.diffs.length === 0
      ? H.div([H.Class(emptyStateClass)], [changes.dirty ? "No renderable file diffs" : "Workspace clean"])
      : H.div([H.Class("grid")], changes.diffs.map(orbChangeRowView)),
  ])
}

const orbChangeRowView = (row: Extract<Model["orb_changes"], { readonly state: "loaded" }>["diffs"][number]): Html =>
  row.kind === "diff" ? orbChangeDiffView(row) : orbChangeSkippedView(row)

const orbChangeSkippedView = (
  row: Extract<Model["orb_changes"], { readonly state: "loaded" }>["diffs"][number] & { readonly kind: "skipped" },
): Html =>
  H.article(
    [H.Key(row.payload_id), H.Class(eventRowDiffClass)],
    [
      H.div(
        [H.Class(eventMetaClass)],
        [H.strong([], [row.file_name]), Ui.badge(["skipped"], "warning"), H.span([], [row.reason])],
      ),
    ],
  )

const orbChangeDiffView = (
  diff: Extract<Model["orb_changes"], { readonly state: "loaded" }>["diffs"][number] & { readonly kind: "diff" },
): Html =>
  H.article(
    [H.Key(diff.payload_id), H.Class(eventRowDiffClass)],
    [
      H.div(
        [H.Class(eventMetaClass)],
        [
          H.strong([], [diff.file_name]),
          H.span([H.Class(diffStatAddClass)], [`+${diff.additions}`]),
          H.span([H.Class(diffStatDeleteClass)], [`-${diff.deletions}`]),
        ],
      ),
      H.div(
        [
          H.Class(pierreDiffMountClass),
          H.DataAttribute("orb-change-diff-id", diff.payload_id),
          H.OnMount(
            MountPierreDiff({
              payload_id: diff.payload_id,
              file_diff: diff.file_diff,
              theme_type: "light",
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
  if (!localUser) {
    return H.article(
      [H.Class("min-w-0 text-[13px] leading-relaxed"), H.DataAttribute("transcript-row-kind", "message")],
      markdownContent(row.body),
    )
  }
  return Ui.Message.message({ align: "end", attributes: [H.DataAttribute("transcript-row-kind", "message")] }, [
    Ui.Message.messageContent({}, [
      Ui.Bubble.bubble({ align: "end", variant: "default" }, [Ui.Bubble.bubbleContent({}, markdownContent(row.body))]),
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
        Ui.cn(
          eventRowClass,
          row.kind === "message" && "border-l-[3px] border-l-[color:var(--success)]",
          row.kind === "error" && "border-l-[3px] border-l-destructive",
        ),
      ),
      H.DataAttribute("transcript-row-kind", row.kind),
    ],
    [
      H.div([H.Class(eventMetaClass)], [H.span([], [`#${row.sequence}`]), H.strong([], [row.title])]),
      H.p([H.Class("m-0 whitespace-pre-wrap")], [row.body]),
    ],
  )

const toolName = (title: string): string => title.replace(/^Tool input:\s*/, "").replace(/^Tool:\s*/, "")

const toolStatus = (body: string): Ui.Tool.ToolStatus =>
  body === "Running" || body === "Started" ? "input-available" : "output-available"

const pierreDiffRowView = (row: Extract<TranscriptRow, { readonly kind: "pierre-diff" }>): Html =>
  H.article(
    [H.Key(row.id), H.Class(eventRowDiffClass)],
    [
      H.div(
        [H.Class(eventMetaClass)],
        [
          H.span([], [`#${row.sequence}`]),
          H.strong([], [row.title]),
          H.span([H.Class(diffStatAddClass)], [`+${row.diff.additions}`]),
          H.span([H.Class(diffStatDeleteClass)], [`-${row.diff.deletions}`]),
        ],
      ),
      H.div(
        [H.Class(Ui.cn(sectionHeaderClass, compactButtonsClass))],
        [
          H.span([H.Class(monoTextClass)], [row.diff.file_name]),
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
              H.Class(pierreDiffMountClass),
              H.DataAttribute("pierre-diff-id", row.diff.payload_id),
              H.OnMount(
                MountPierreDiff({
                  payload_id: row.diff.payload_id,
                  file_diff: row.diff.file_diff,
                  theme_type: "light",
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
  return Ui.PromptInput.promptInput(
    {
      class: "grid gap-2 rounded-2xl border border-border bg-card px-3.5 py-3 shadow-sm",
      onSubmitted: SubmittedDraft(),
    },
    [
      Ui.PromptInput.promptInputTextarea({
        id: "turn-input",
        value: model.draft,
        onInput: (value) => ChangedDraft({ value }),
        placeholder: model.selected_thread_id === undefined ? "Start a new Rika thread" : "Send a turn to this thread",
        rows: 3,
        attributes: [H.AriaLabel("Turn input")],
      }),
      Ui.PromptInput.promptInputToolbar({ class: "flex items-center justify-between gap-4" }, [
        Ui.PromptInput.promptInputTools({ class: "flex items-center gap-1" }, [
          H.button(
            [
              H.Type("button"),
              H.Class(
                "grid size-7 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              ),
              H.AriaLabel("Attach image"),
            ],
            [iconImage("size-4")],
          ),
        ]),
        Ui.PromptInput.promptInputTools({ class: "flex items-center gap-2" }, [
          connectionStatus(model),
          Ui.select({
            id: "turn-mode",
            value: model.draft_mode ?? "",
            options: modeOptions,
            onChange: (value) => ChangedDraftMode({ value }),
            attributes: [H.AriaLabel("Mode")],
            class: "w-28",
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
            [],
          ),
        ]),
      ]),
    ],
  )
}

const activeTitle = (model: Model) => {
  if (model.active_view === "projects") return "Projects"
  const thread = model.threads.find((item) => item.thread_id === model.selected_thread_id)
  return thread?.title_text ?? (model.selected_thread_id === undefined ? "" : shortId(model.selected_thread_id))
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
