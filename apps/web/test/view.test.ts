import { Event, Ids, Message as RikaMessage, Remote } from "@rika/schema"
import { describe, expect, test } from "bun:test"
import type { Html } from "foldkit/html"
import {
  initialModel,
  LoadedOrbChanges,
  LoadedOrbDirectory,
  LoadedOrbFile,
  GotDeleteSecretDialogMessage,
  GotTranscriptScrollerMessage,
  MountOrbTerminal,
  MountPierreDiff,
  MountPierreTree,
  RenderedPierreDiff,
  RenderedPierreTree,
  SelectedOrbFile,
  TerminalStatusChanged,
  update,
  type Model,
  type OrbTab,
} from "../src/app"
import { CompletedShowDialog, ShowDialog } from "../src/components/ui/alert-dialog"
import {
  CompletedScrollToBottom,
  GrewContent,
  ObserveContentGrowth,
  ScrolledViewport,
  ScrollToBottom,
  TrackViewportScroll,
} from "../src/components/ui/message-scroller-state"

Object.assign(globalThis, {
  window: {
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  },
})

const [Scene, View] = await Promise.all([import("foldkit/scene"), import("../src/view")])

const threadId = Ids.ThreadId.make("thread-view")
const secondThreadId = Ids.ThreadId.make("thread-view-second")
const workspaceId = Ids.WorkspaceId.make("workspace-view")
const messageId = Ids.MessageId.make("message-view")
const orbId = Ids.OrbId.make("orb-view")
const projectId = Ids.ProjectId.make("project-view")
const userId = Ids.UserId.make("user_view")
const otherUserId = Ids.UserId.make("sarah")

describe("web app view", () => {
  test("renders an accessible orb tab shell for orb-backed threads", () => {
    Scene.scene(
      { update, view: View.view },
      Scene.with(orbModel("transcript", 0)),
      Scene.expect(Scene.role("tablist", { name: "Orb workspace" })).toExist(),
      Scene.expect(Scene.role("tab", { name: "Transcript", selected: true })).toExist(),
      Scene.expect(Scene.role("tab", { name: "Files" })).toExist(),
      Scene.expect(Scene.role("tab", { name: "Changes" })).toExist(),
      Scene.expect(Scene.role("tab", { name: "Terminal" })).toExist(),
      Scene.expect(Scene.role("tabpanel")).toContainText("hello from view"),
      Scene.expect(Scene.text("runtime 7m")).toExist(),
      ...resolveTranscriptScroller(),
    )
  })

  test("renders the read-only orb file browser and opened text file", () => {
    Scene.scene(
      { update, view: View.view },
      Scene.with(filesModel()),
      Scene.expect(Scene.role("tab", { name: "Files", selected: true })).toExist(),
      Scene.expect(Scene.role("tabpanel")).toContainText("README.md"),
      Scene.expect(Scene.role("tabpanel")).toContainText("hello from file"),
      Scene.expect(Scene.selector("[data-pierre-tree]")).toExist(),
      Scene.Mount.expectHas(MountPierreTree),
      Scene.Mount.resolve(MountPierreTree, RenderedPierreTree({ selected_path: "README.md" })),
    )
  })

  test("renders parsed orb changes as Pierre diff mounts", () => {
    Scene.scene(
      { update, view: View.view },
      Scene.with(changesModel()),
      Scene.expect(Scene.role("tab", { name: "Changes", selected: true })).toExist(),
      Scene.expect(Scene.text("README.md")).toExist(),
      Scene.expect(Scene.text("+1")).toExist(),
      Scene.expect(Scene.selector('[data-orb-change-diff-id="orb-changes:0:0"]')).toExist(),
      Scene.Mount.expectHas(MountPierreDiff),
      Scene.Mount.resolve(MountPierreDiff, RenderedPierreDiff({ payload_id: "orb-changes:0:0" })),
    )
  })

  test("renders the orb terminal mount and reconnect control", () => {
    Scene.scene(
      { update, view: View.view },
      Scene.with(terminalModel()),
      Scene.expect(Scene.role("tab", { name: "Terminal", selected: true })).toExist(),
      Scene.expect(Scene.role("button", { name: "Reconnect" })).toExist(),
      Scene.expect(Scene.selector("[data-orb-terminal]")).toExist(),
      Scene.Mount.expectHas(MountOrbTerminal),
      Scene.Mount.resolve(MountOrbTerminal, TerminalStatusChanged({ status: "connected" })),
      Scene.expect(Scene.role("tabpanel")).toContainText("connected"),
    )
  })

  test("keys the orb terminal mount by selected thread", () => {
    Scene.scene(
      { update, view: View.view },
      Scene.with(terminalModel()),
      Scene.tap((simulation) => expect(terminalMountKey(simulation.html)).toBe(`orb-terminal:${threadId}`)),
      Scene.Mount.resolve(MountOrbTerminal, TerminalStatusChanged({ status: "connected" })),
    )
    Scene.scene(
      { update, view: View.view },
      Scene.with(terminalModelForThread(secondThreadId)),
      Scene.tap((simulation) => expect(terminalMountKey(simulation.html)).toBe(`orb-terminal:${secondThreadId}`)),
      Scene.Mount.resolve(MountOrbTerminal, TerminalStatusChanged({ status: "connected" })),
    )
  })

  test("keys the Pierre tree mount by selected thread and orb", () => {
    Scene.scene(
      { update, view: View.view },
      Scene.with(filesModel()),
      Scene.tap((simulation) => expect(treeMountKey(simulation.html)).toBe(`orb-tree:${threadId}:${orbId}`)),
      Scene.Mount.resolve(MountPierreTree, RenderedPierreTree({ selected_path: "README.md" })),
    )
    Scene.scene(
      { update, view: View.view },
      Scene.with({
        ...filesModel(),
        selected_thread_id: secondThreadId,
        selected_orb: {
          ...orbSummary("running"),
          orb_id: Ids.OrbId.make("orb-view-second"),
          thread_id: secondThreadId,
        },
      }),
      Scene.tap((simulation) =>
        expect(treeMountKey(simulation.html)).toBe(`orb-tree:${secondThreadId}:orb-view-second`),
      ),
      Scene.Mount.resolve(MountPierreTree, RenderedPierreTree({ selected_path: "README.md" })),
    )
  })

  test("passes git status markers into the Pierre tree mount", () => {
    Scene.scene(
      { update, view: View.view },
      Scene.with(filesWithChangesModel()),
      Scene.tap(({ mounts }) => {
        const tree = mounts.find((mount) => mount.name === "MountPierreTree")
        expect(tree?.args?.git_status).toEqual([{ path: "README.md", status: "modified" }])
      }),
      Scene.Mount.resolve(MountPierreTree, RenderedPierreTree({ selected_path: "README.md" })),
    )
  })

  test("renders terminal failure status from the model", () => {
    Scene.scene(
      { update, view: View.view },
      Scene.with({ ...terminalModel(), orb_terminal_status: "failed" as const, orb_terminal_error: "socket closed" }),
      Scene.expect(Scene.role("tabpanel")).toContainText("failed"),
      Scene.expect(Scene.role("tabpanel")).toContainText("socket closed"),
      Scene.Mount.resolve(MountOrbTerminal, TerminalStatusChanged({ status: "failed" })),
    )
  })

  test("renders projects settings with env values and write-only secrets", () => {
    Scene.scene(
      { update, view: View.view },
      Scene.with(projectsModel()),
      Scene.expect(Scene.role("button", { name: "Projects" })).toExist(),
      Scene.expect(Scene.text("demo")).toExist(),
      Scene.expect(Scene.text("NODE_ENV")).toExist(),
      Scene.expect(Scene.displayValue("development")).toExist(),
      Scene.expect(Scene.text("OPENAI_API_KEY")).toExist(),
      Scene.expect(Scene.text("****")).toExist(),
      Scene.expect(Scene.displayValue("secret-value")).not.toExist(),
      Scene.click(Scene.role("button", { name: "Delete" })),
      Scene.expect(Scene.role("alertdialog")).toContainText("Delete secret?"),
      Scene.expect(Scene.role("button", { name: "Delete" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Cancel" })).toExist(),
      Scene.Command.resolve(ShowDialog, CompletedShowDialog(), (message) => GotDeleteSecretDialogMessage({ message })),
    )
  })

  test("renders unrenderable orb changes as skipped rows", () => {
    Scene.scene(
      { update, view: View.view },
      Scene.with(skippedChangesModel()),
      Scene.expect(Scene.role("tab", { name: "Changes", selected: true })).toExist(),
      Scene.expect(Scene.text("image.bin")).toExist(),
      Scene.expect(Scene.text("skipped")).toExist(),
      Scene.expect(Scene.text("No renderable hunks")).toExist(),
    )
  })

  test("renders collapsed Pierre diff rows with an expansion control", () => {
    Scene.scene(
      { update, view: View.view },
      Scene.with(diffModel([])),
      Scene.expect(Scene.text("src/view-diff.ts")).toExist(),
      Scene.expect(Scene.role("button", { name: "Show diff" })).toExist(),
      ...resolveTranscriptScroller(),
      Scene.click(Scene.role("button", { name: "Show diff" })),
      Scene.expect(Scene.role("button", { name: "Hide diff" })).toExist(),
      Scene.expect(Scene.selector('[data-pierre-diff-id="event-2:diff:0"]')).toExist(),
      Scene.Mount.expectHas(MountPierreDiff),
      Scene.Mount.resolve(MountPierreDiff, RenderedPierreDiff({ payload_id: "event-2:diff:0" })),
    )
  })

  test("renders expanded Pierre diff rows with stable mount slots", () => {
    Scene.scene(
      { update, view: View.view },
      Scene.with(diffModel(["event-2:diff:0"])),
      Scene.expect(Scene.selector('[data-pierre-diff-id="event-2:diff:0"]')).toExist(),
      Scene.Mount.expectHas(MountPierreDiff),
      Scene.Mount.resolve(MountPierreDiff, RenderedPierreDiff({ payload_id: "event-2:diff:0" })),
      ...resolveTranscriptScroller(),
    )
  })

  test("renders mode selection and shows Stop only for an active durable turn", () => {
    Scene.scene(
      { update, view: View.view },
      Scene.with(activeTurnModel()),
      Scene.expect(Scene.role("combobox", { name: "Mode" })).toExist(),
      Scene.expect(Scene.text("deep2")).toExist(),
      Scene.expect(Scene.role("button", { name: "Stop" })).toExist(),
      ...resolveTranscriptScroller(),
    )

    Scene.scene(
      { update, view: View.view },
      Scene.with(terminalTurnModel()),
      Scene.expect(Scene.role("combobox", { name: "Mode" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Stop" })).not.toExist(),
      ...resolveTranscriptScroller(),
    )
  })

  test("renders multiplayer presence and message attribution", () => {
    Scene.scene(
      { update, view: View.view },
      Scene.with({
        ...initialModel({ api_base_url: "/api/rika", user_id: userId }),
        selected_thread_id: threadId,
        subscribed_thread_id: threadId,
        threads: [summary(threadId)],
        events: [messageAdded(1, "user", "hello from Sarah", otherUserId)],
        last_sequence: 1,
        subscription_after_sequence: 1,
        presence: [{ user_id: otherUserId, state: "typing", last_seen: 2 }],
        connection: "connected",
      }),
      Scene.expect(Scene.text("S")).toExist(),
      Scene.expect(Scene.text("sarah is typing")).toExist(),
      Scene.expect(Scene.text("sarah")).toExist(),
      Scene.expect(Scene.text("hello from Sarah")).toExist(),
      ...resolveTranscriptScroller(),
    )
  })

  test("renders transcript rows through foldcn chat components", () => {
    Scene.scene(
      { update, view: View.view },
      Scene.with({
        ...orbModel("transcript", 0),
        events: [
          messageAdded(1, "user", "hello from user", userId),
          messageAdded(2, "assistant", "```ts\nconst value = 1\n```"),
          reasoningDelta(3, "checking files"),
          toolCallCompleted(4, "read", { ok: true }),
        ],
        last_sequence: 4,
        subscription_after_sequence: 4,
      }),
      Scene.expect(Scene.selector('[data-slot="message-scroller"]')).toExist(),
      Scene.expect(Scene.selector('[data-slot="message"]')).toExist(),
      Scene.expect(Scene.selector('[data-slot="bubble"]')).toExist(),
      Scene.expect(Scene.selector('[data-slot="reasoning"]')).toExist(),
      Scene.expect(Scene.selector('[data-slot="tool"]')).toExist(),
      Scene.expect(Scene.selector('[data-slot="code-block"]')).toExist(),
      Scene.expect(Scene.selector('[data-slot="prompt-input"]')).toExist(),
      Scene.expect(Scene.selector('[data-slot="prompt-input-textarea"]')).toExist(),
      ...resolveTranscriptScroller(),
    )
  })

  test("renders assistant markdown as semantic elements, not literal syntax", () => {
    Scene.scene(
      { update, view: View.view },
      Scene.with({
        ...orbModel("transcript", 0),
        events: [messageAdded(1, "assistant", "## Title\n\nSome **bold** text.")],
      }),
      Scene.expect(Scene.role("heading", { name: "Title" })).toExist(),
      Scene.expect(Scene.text("## Title")).toBeAbsent(),
      Scene.expect(Scene.selector(".markdown-body strong")).toExist(),
      Scene.expect(Scene.role("tabpanel")).toContainText("Some bold text."),
      ...resolveTranscriptScroller(),
    )
  })

  test("folds streamed chunks into a single assistant bubble", () => {
    Scene.scene(
      { update, view: View.view },
      Scene.with({
        ...orbModel("transcript", 0),
        events: [streamChunk(2, "First sentence. "), streamChunk(3, "Second sentence.")],
        last_sequence: 3,
        subscription_after_sequence: 3,
      }),
      Scene.expectAll(Scene.all.selector('[data-slot="bubble"]')).toHaveCount(1),
      Scene.expect(Scene.text("First sentence. Second sentence.")).toExist(),
      ...resolveTranscriptScroller(),
    )
  })

  test("renders sidebar thread search controls", () => {
    Scene.scene(
      { update, view: View.view },
      Scene.with({
        ...initialModel({ api_base_url: "/api/rika" }),
        threads: [summary(threadId)],
        thread_search_query: "file:src/view.ts",
        thread_search_window: "72h",
      }),
      Scene.expect(Scene.role("searchbox", { name: "Thread search" })).toExist(),
      Scene.expect(Scene.displayValue("file:src/view.ts")).toExist(),
      Scene.expect(Scene.role("combobox", { name: "Thread search window" })).toExist(),
      Scene.expect(Scene.text("72h")).toExist(),
      ...resolveTranscriptScroller(),
    )
  })
})

const resolveTranscriptScroller = () =>
  [
    Scene.Mount.resolve(TrackViewportScroll, ScrolledViewport({ isAtBottom: true }), (message) =>
      GotTranscriptScrollerMessage({ message }),
    ),
    Scene.Mount.resolve(ObserveContentGrowth, GrewContent(), (message) => GotTranscriptScrollerMessage({ message })),
    Scene.Command.resolve(ScrollToBottom, CompletedScrollToBottom(), (message) =>
      GotTranscriptScrollerMessage({ message }),
    ),
  ] as const

const orbModel = (selected_orb_tab: OrbTab, activeIndex: number): Model => {
  const model: Model = {
    ...initialModel({ api_base_url: "/api/rika" }),
    selected_thread_id: threadId,
    subscribed_thread_id: threadId,
    selected_orb: orbSummary("running"),
    selected_orb_tab,
    orb_tabs: tabModel(activeIndex),
    threads: [summary(threadId, { orb_status: "running" })],
    events: [messageAdded(1, "assistant", "hello from view")],
    last_sequence: 1,
    subscription_after_sequence: 1,
    connection: "connected",
  }
  return model
}

const diffModel = (expanded_diff_ids: ReadonlyArray<string>): Model => {
  const model: Model = {
    ...orbModel("transcript", 0),
    events: [toolCallCompleted(2, "edit", { diff: pierreDiff("src/view-diff.ts", 1, 1) })],
    expanded_diff_ids,
    last_sequence: 2,
    subscription_after_sequence: 2,
  }
  return model
}

const activeTurnModel = (): Model => ({
  ...orbModel("transcript", 0),
  events: [turnStarted(2, Ids.TurnId.make("turn-view-active"))],
  last_sequence: 2,
  subscription_after_sequence: 2,
})

const terminalTurnModel = (): Model => {
  const turnId = Ids.TurnId.make("turn-view-terminal")
  return {
    ...orbModel("transcript", 0),
    events: [turnStarted(2, turnId), turnFailed(3, turnId)],
    last_sequence: 3,
    subscription_after_sequence: 3,
  }
}

const filesModel = (): Model => {
  const [listed] = update(
    orbModel("files", 1),
    LoadedOrbDirectory({
      response: {
        path: "",
        entries: [{ name: "README.md", path: "README.md", kind: "file", size: 15 }],
      },
    }),
  )
  const [selected] = update(listed, SelectedOrbFile({ path: "README.md" }))
  const [opened] = update(
    selected,
    LoadedOrbFile({
      response: { path: "README.md", kind: "text", content: "hello from file\n", truncated: false },
    }),
  )
  return opened
}

const filesWithChangesModel = (): Model => {
  const [loaded] = update(
    filesModel(),
    LoadedOrbChanges({
      response: {
        base_commit: "abc123",
        head_commit: "def456",
        dirty: true,
        diff: gitPatch("README.md"),
      },
    }),
  )
  return loaded
}

const changesModel = (): Model => {
  const [loaded] = update(
    orbModel("changes", 2),
    LoadedOrbChanges({
      response: {
        base_commit: "abc123",
        head_commit: "def456",
        dirty: true,
        diff: gitPatch("README.md"),
      },
    }),
  )
  return loaded
}

const skippedChangesModel = (): Model => {
  const [loaded] = update(
    orbModel("changes", 2),
    LoadedOrbChanges({
      response: {
        base_commit: "abc123",
        head_commit: "def456",
        dirty: true,
        diff: binaryGitPatch("image.bin"),
      },
    }),
  )
  return loaded
}

const terminalModel = (): Model => ({
  ...orbModel("terminal", 3),
})

const terminalModelForThread = (selected_thread_id: Ids.ThreadId): Model => ({
  ...orbModel("terminal", 3),
  selected_thread_id,
  selected_orb: { ...orbSummary("running"), thread_id: selected_thread_id },
  threads: [
    summary(threadId, { orb_status: "running" }),
    summary(selected_thread_id, { orb_status: "running", title_text: "Second thread" }),
  ],
})

const projectsModel = (): Model =>
  ({
    ...initialModel({ api_base_url: "/api/rika" }),
    active_view: "projects",
    projects: [projectSummary()],
    selected_project_id: projectId,
    selected_project: projectDetail(),
    project_form: {
      name: "demo",
      repo_origin: "https://github.com/example/rika.git",
      default_branch: "main",
      template_id: "",
      env: { NODE_ENV: "development" },
    },
    new_project_form: {
      name: "",
      repo_origin: "",
      default_branch: "main",
      template_id: "",
      env_key: "",
      env_value: "",
    },
    project_secret_name: "OPENAI_API_KEY",
    project_secret_value: "",
  }) as Model

const projectSummary = (): Remote.ProjectSummary => ({
  project_id: projectId,
  name: "demo",
  repo_origin: "https://github.com/example/rika.git",
  default_branch: "main",
  template_id: null,
  env_keys: ["NODE_ENV"],
  secret_names: ["OPENAI_API_KEY"],
  created_at: 1,
  updated_at: 2,
})

const projectDetail = (): Remote.ProjectDetail => ({
  project_id: projectId,
  name: "demo",
  repo_origin: "https://github.com/example/rika.git",
  default_branch: "main",
  template_id: null,
  env: { NODE_ENV: "development" },
  secret_names: ["OPENAI_API_KEY"],
  created_at: 1,
  updated_at: 2,
})

const terminalMountKey = (html: Html): string | undefined => {
  if (html === null) return undefined
  if (html.data?.attrs?.["data-orb-terminal"] === "") {
    return typeof html.data.key === "string" ? html.data.key : undefined
  }
  for (const child of html.children ?? []) {
    if (typeof child !== "string") {
      const key = terminalMountKey(child)
      if (key !== undefined) return key
    }
  }
  return undefined
}

const treeMountKey = (html: Html): string | undefined => {
  if (html === null) return undefined
  if (html.data?.attrs?.["data-pierre-tree"] === "") {
    return typeof html.data.key === "string" ? html.data.key : undefined
  }
  for (const child of html.children ?? []) {
    if (typeof child !== "string") {
      const key = treeMountKey(child)
      if (key !== undefined) return key
    }
  }
  return undefined
}

const tabModel = (activeIndex: number) => ({
  id: "orb-tabs",
  activeIndex,
  focusedIndex: activeIndex,
  activationMode: "Automatic" as const,
})

const summary = (id: Ids.ThreadId, input: Partial<Remote.ThreadSummary> = {}): Remote.ThreadSummary => ({
  thread_id: id,
  workspace_id: workspaceId,
  title_text: "View thread",
  latest_message_text: "Latest",
  diff: { additions: 0, modifications: 0, deletions: 0 },
  archived: false,
  visibility: "private",
  created_at: 1,
  updated_at: 2,
  ...input,
})

const orbSummary = (status: Remote.OrbSummary["status"]): Remote.OrbSummary => ({
  orb_id: orbId,
  thread_id: threadId,
  project_id: projectId,
  status,
  base_commit: "abc123",
  created_at: 1,
  last_active_at: 121_001,
  running_minutes: 7,
})

const messageAdded = (
  sequence: number,
  role: RikaMessage.Role,
  text: string,
  messageUserId?: Ids.UserId,
): Event.MessageAdded => ({
  id: Ids.EventId.make(`event-${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "message.added" as const,
  data: {
    message: {
      id: messageId,
      thread_id: threadId,
      role,
      content: [RikaMessage.text(text)],
      created_at: sequence,
      ...(messageUserId === undefined ? {} : { metadata: { user_id: messageUserId } }),
    },
  },
})

const streamChunk = (sequence: number, text: string): Event.ModelStreamChunk => ({
  id: Ids.EventId.make(`event-${sequence}`),
  thread_id: threadId,
  turn_id: Ids.TurnId.make("turn-view"),
  sequence,
  version: 1,
  created_at: sequence,
  type: "model.stream.chunk",
  data: { text, provider: "openai", model: "gpt-5.5" },
})

const toolCallCompleted = (
  sequence: number,
  name: string,
  output: NonNullable<Event.ToolCallCompleted["data"]["result"]["output"]>,
): Event.ToolCallCompleted => ({
  id: Ids.EventId.make(`event-${sequence}`),
  thread_id: threadId,
  turn_id: Ids.TurnId.make("turn-view"),
  sequence,
  version: 1,
  created_at: sequence,
  type: "tool.call.completed",
  data: {
    result: {
      id: Ids.ToolCallId.make(`tool-view-${sequence}`),
      name,
      status: "success",
      output,
    },
  },
})

const turnStarted = (sequence: number, turnId: Ids.TurnId): Event.TurnStarted => ({
  id: Ids.EventId.make(`event-${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "turn.started",
  data: {},
})

const turnFailed = (sequence: number, turnId: Ids.TurnId): Event.TurnFailed => ({
  id: Ids.EventId.make(`event-${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "turn.failed",
  data: { error: { kind: "cancelled", message: "cancelled" } },
})

const reasoningDelta = (sequence: number, text: string): Event.ModelReasoningDelta => ({
  id: Ids.EventId.make(`event-${sequence}`),
  thread_id: threadId,
  turn_id: Ids.TurnId.make("turn-view"),
  sequence,
  version: 1,
  created_at: sequence,
  type: "model.reasoning.delta",
  data: { text, provider: "openai", model: "gpt-5.5" },
})

const pierreDiff = (name: string, additions: number, deletions: number) => ({
  kind: "diff",
  renderer: "@pierre/diffs",
  collapsed: true,
  file_diff: fileDiff(name, additions, deletions),
})

const fileDiff = (name: string, additions: number, deletions: number) => ({
  name,
  type: "change" as const,
  splitLineCount: additions + deletions,
  unifiedLineCount: additions + deletions,
  isPartial: false,
  deletionLines: Array.from({ length: deletions }, (_, index) => `before ${index}`),
  additionLines: Array.from({ length: additions }, (_, index) => `after ${index}`),
  hunks: [
    {
      collapsedBefore: 0,
      additionStart: 1,
      additionCount: additions,
      additionLines: additions,
      additionLineIndex: 0,
      deletionStart: 1,
      deletionCount: deletions,
      deletionLines: deletions,
      deletionLineIndex: 0,
      hunkContent: [{ type: "change" as const, deletions, deletionLineIndex: 0, additions, additionLineIndex: 0 }],
      splitLineStart: 0,
      splitLineCount: additions + deletions,
      unifiedLineStart: 0,
      unifiedLineCount: additions + deletions,
      noEOFCRDeletions: false,
      noEOFCRAdditions: false,
    },
  ],
})

const gitPatch = (name: string) => `diff --git a/${name} b/${name}
index e69de29..b6fc4c6 100644
--- a/${name}
+++ b/${name}
@@ -0,0 +1 @@
+hello
`

const binaryGitPatch = (name: string) => `diff --git a/${name} b/${name}
new file mode 100644
index 0000000..1234567
GIT binary patch
literal 3
KcmZQzU|?Wm5C8xG

literal 0
HcmV?d00001
`
