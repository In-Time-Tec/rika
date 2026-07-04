import { Event, Ids, Message as RikaMessage, Remote } from "@rika/schema"
import { describe, expect, test } from "bun:test"
import {
  ChangedDraft,
  ChangedDraftMode,
  ChangedProjectEnvValue,
  ChangedProjectField,
  ChangedProjectSecretField,
  CancelledDeleteProjectSecret,
  CancelledKillOrb,
  ClickedInterrupt,
  ClickedDeleteProjectSecret,
  ClickedProject,
  ClickedProjects,
  ClickedThread,
  ClickedKillOrb,
  ClickedNewThread,
  ClickedPauseOrb,
  ConfirmedKillOrb,
  ConfirmedDeleteProjectSecret,
  FailedSaveProject,
  GotOrbTabsMessage,
  LoadedOrbChanges,
  LoadedOrbDirectory,
  LoadedOrbFile,
  LoadedProject,
  LoadedProjects,
  LoadedThreads,
  OpenedThread,
  ReceivedThreadEvent,
  ReceivedPresence,
  RequestedTerminalReconnect,
  SavedProject,
  SubmittedProjectSecret,
  SubmittedProjectSettings,
  SelectedOrbFile,
  SubmittedDraft,
  TypingPresenceReady,
  TerminalFailed,
  TerminalStatusChanged,
  UpdatedSelectedOrb,
  contextUsage,
  eventRows,
  init,
  initialModel,
  update,
} from "../src/app"

const threadId = Ids.ThreadId.make("thread-web")
const workspaceId = Ids.WorkspaceId.make("workspace-web")
const messageId = Ids.MessageId.make("message-web")
const orbId = Ids.OrbId.make("orb-web")
const projectId = Ids.ProjectId.make("project-web")
const userId = Ids.UserId.make("user_web")
const otherUserId = Ids.UserId.make("sarah")

describe("web app state", () => {
  test("imports only browser-safe LLM modules", async () => {
    const source = await Bun.file(new URL("../src/app.ts", import.meta.url)).text()

    expect(source).not.toContain('from "@rika/llm"')
    expect(source).toContain('from "@rika/llm/model-info"')
  })

  test("initializes by loading backend state and the requested thread", () => {
    const [model, commands] = init({ api_base_url: "/api/rika", thread_id: threadId })

    expect(model.api_base_url).toBe("/api/rika")
    expect(model.selected_thread_id).toBe(threadId)
    expect(model.selected_orb_tab).toBe("transcript")
    expect(model.orb_tabs.activeIndex).toBe(0)
    expect(model.orb_terminal_status).toBe("idle")
    expect(commands.map((command) => command.name)).toEqual(["LoadBackendHealth", "LoadThreads", "OpenThread"])
  })

  test("routes orb tab selections through Foldkit tab state", () => {
    const [next, commands] = update(
      initialModel({ api_base_url: "/api/rika" }),
      GotOrbTabsMessage({ message: { _tag: "SelectedTab", value: "files", index: 1 } }),
    )

    expect(next.selected_orb_tab).toBe("files")
    expect(next.orb_tabs.activeIndex).toBe(1)
    expect(next.orb_tabs.focusedIndex).toBe(1)
    expect(commands.map((command) => command.name)).toEqual(["FocusTab"])
  })

  test("loads orb file state through the selected thread endpoint", () => {
    const model = {
      ...initialModel({ api_base_url: "/api/rika" }),
      selected_thread_id: threadId,
      selected_orb: orbSummary("running"),
      threads: [summary(threadId, { orb_status: "running" })],
    }

    const [tabbed, tabCommands] = update(
      model,
      GotOrbTabsMessage({ message: { _tag: "SelectedTab", value: "files", index: 1 } }),
    )
    const [listed] = update(
      tabbed,
      LoadedOrbDirectory({
        response: {
          path: "",
          entries: [
            { name: "src", path: "src", kind: "dir" },
            { name: "README.md", path: "README.md", kind: "file", size: 6 },
          ],
        },
      }),
    )
    const [selected, selectCommands] = update(listed, SelectedOrbFile({ path: "README.md" }))
    const [opened] = update(
      selected,
      LoadedOrbFile({
        response: { path: "README.md", kind: "text", content: "hello\n", truncated: false },
      }),
    )

    expect(tabbed.orb_files.directories[""]?.state).toBe("loading")
    expect(tabCommands.map((command) => command.name)).toEqual(["FocusTab", "LoadOrbDirectory"])
    expect(tabCommands[1]?.args).toEqual({ api_base_url: "/api/rika", thread_id: threadId, path: "" })
    expect(listed.orb_files.paths).toEqual(["src/", "README.md"])
    expect(listed.orb_files.path_kinds).toEqual({ src: "dir", "README.md": "file" })
    expect(selected.orb_files.opened_file).toEqual({ state: "loading", path: "README.md" })
    expect(selectCommands.map((command) => command.name)).toEqual(["LoadOrbFile"])
    expect(selectCommands[0]?.args).toEqual({ api_base_url: "/api/rika", thread_id: threadId, path: "README.md" })
    expect(opened.orb_files.opened_file).toEqual({
      state: "text",
      path: "README.md",
      content: "hello\n",
      truncated: false,
    })
  })

  test("loads child directories when selecting a known orb directory", () => {
    const model = {
      ...initialModel({ api_base_url: "/api/rika" }),
      selected_thread_id: threadId,
      selected_orb: orbSummary("running"),
      threads: [summary(threadId, { orb_status: "running" })],
      orb_files: {
        ...initialModel({ api_base_url: "/api/rika" }).orb_files,
        paths: ["src/"],
        path_kinds: { src: "dir" as const },
        directories: { "": { state: "loaded" as const } },
      },
    }

    const [selected, commands] = update(model, SelectedOrbFile({ path: "src/" }))

    expect(selected.orb_files.selected_path).toBe("src")
    expect(selected.orb_files.directories.src?.state).toBe("loading")
    expect(selected.orb_files.opened_file).toEqual({ state: "idle" })
    expect(commands.map((command) => command.name)).toEqual(["LoadOrbDirectory"])
    expect(commands[0]?.args).toEqual({ api_base_url: "/api/rika", thread_id: threadId, path: "src" })
  })

  test("loads and parses orb changes through the selected thread endpoint", () => {
    const model = {
      ...initialModel({ api_base_url: "/api/rika" }),
      selected_thread_id: threadId,
      selected_orb: orbSummary("running"),
      threads: [summary(threadId, { orb_status: "running" })],
    }

    const [tabbed, tabCommands] = update(
      model,
      GotOrbTabsMessage({ message: { _tag: "SelectedTab", value: "changes", index: 2 } }),
    )
    const [loaded] = update(
      tabbed,
      LoadedOrbChanges({
        response: {
          base_commit: "abc123",
          head_commit: "def456",
          dirty: true,
          diff: gitPatch("README.md"),
        },
      }),
    )

    expect(tabbed.orb_changes.state).toBe("loading")
    expect(tabCommands.map((command) => command.name)).toEqual(["FocusTab", "LoadOrbChanges"])
    expect(tabCommands[1]?.args).toEqual({ api_base_url: "/api/rika", thread_id: threadId })
    expect(loaded.orb_changes).toMatchObject({
      state: "loaded",
      base_commit: "abc123",
      head_commit: "def456",
      dirty: true,
    })
    if (loaded.orb_changes.state !== "loaded") throw new Error("expected loaded changes")
    expect(loaded.orb_changes.diffs).toHaveLength(1)
    expect(loaded.orb_changes.diffs[0]).toMatchObject({
      kind: "diff",
      payload_id: "orb-changes:0:0",
      file_name: "README.md",
      additions: 1,
      deletions: 0,
    })
  })

  test("tracks terminal status and reconnects the selected thread terminal", () => {
    const model = {
      ...initialModel({ api_base_url: "/api/rika" }),
      selected_thread_id: threadId,
      selected_orb: orbSummary("running"),
      threads: [summary(threadId, { orb_status: "running" })],
    }

    const [connected] = update(model, TerminalStatusChanged({ status: "connected" }))
    const [failed] = update(connected, TerminalFailed({ message: "socket closed" }))
    const [reconnecting, commands] = update(failed, RequestedTerminalReconnect())

    expect(connected.orb_terminal_status).toBe("connected")
    expect(connected.orb_terminal_error).toBeUndefined()
    expect(failed.orb_terminal_status).toBe("failed")
    expect(failed.orb_terminal_error).toBe("socket closed")
    expect(reconnecting.orb_terminal_status).toBe("connecting")
    expect(reconnecting.orb_terminal_error).toBeUndefined()
    expect(commands.map((command) => command.name)).toEqual(["ReconnectOrbTerminal"])
    expect(commands[0]?.args).toEqual({ thread_id: threadId })
  })

  test("loads and edits project settings without retaining secret values", () => {
    const project = projectSummary()
    const detail = projectDetail()
    const [projectsView, loadCommands] = update(initialModel({ api_base_url: "/api/rika" }), ClickedProjects())
    const [listed] = update(projectsView, LoadedProjects({ projects: [project] }))
    const [selecting, selectCommands] = update(listed, ClickedProject({ project_id: project.project_id }))
    const [loaded] = update(selecting, LoadedProject({ project: detail }))
    const [renamed] = update(loaded, ChangedProjectField({ field: "name", value: "renamed" }))
    const [withEnv] = update(renamed, ChangedProjectEnvValue({ key: "NODE_ENV", value: "test" }))
    const [saving, saveCommands] = update(withEnv, SubmittedProjectSettings())
    const savedDetail = { ...detail, name: "renamed", env: { NODE_ENV: "test" } }
    const [saved] = update(saving, SavedProject({ project: savedDetail }))
    const [secretDrafted] = update(saved, ChangedProjectSecretField({ field: "value", value: "secret-value" }))
    const [settingSecret, secretCommands] = update(secretDrafted, SubmittedProjectSecret())
    const [failedSecret] = update(settingSecret, FailedSaveProject({ message: "network failed" }))
    const [secretSaved] = update(
      settingSecret,
      SavedProject({ project: { ...savedDetail, secret_names: ["OPENAI_API_KEY"] } }),
    )
    const [confirmingDelete, deleteClickCommands] = update(
      secretSaved,
      ClickedDeleteProjectSecret({ name: "OPENAI_API_KEY" }),
    )
    const [cancelledDelete, cancelCommands] = update(confirmingDelete, CancelledDeleteProjectSecret())
    const [confirmingDeleteAgain] = update(cancelledDelete, ClickedDeleteProjectSecret({ name: "OPENAI_API_KEY" }))
    const [deletingSecret, deleteCommands] = update(confirmingDeleteAgain, ConfirmedDeleteProjectSecret())

    expect(projectsView.active_view).toBe("projects")
    expect(loadCommands.map((command) => command.name)).toEqual(["LoadProjects"])
    expect(listed.projects).toEqual([project])
    expect(selectCommands.map((command) => command.name)).toEqual(["LoadProject"])
    expect(selectCommands[0]?.args).toEqual({ api_base_url: "/api/rika", project_id: project.project_id })
    expect(loaded.project_form.name).toBe("demo")
    expect(loaded.project_form.env).toEqual({ NODE_ENV: "development" })
    expect(saveCommands.map((command) => command.name)).toEqual(["UpdateProjectSettings"])
    expect(saveCommands[0]?.args).toEqual({
      api_base_url: "/api/rika",
      project_id: project.project_id,
      name: "renamed",
      repo_origin: "https://github.com/example/rika.git",
      default_branch: "main",
      template_id: null,
      env: { NODE_ENV: "test" },
    })
    expect(saved.projects[0]).toMatchObject({ name: "renamed", env_keys: ["NODE_ENV"] })
    expect(secretCommands.map((command) => command.name)).toEqual(["SetProjectSecret"])
    expect(secretCommands[0]?.args).toEqual({
      api_base_url: "/api/rika",
      project_id: project.project_id,
      name: "OPENAI_API_KEY",
      value: "secret-value",
    })
    expect(settingSecret.project_secret_value).toBe("")
    expect(failedSecret.project_secret_value).toBe("")
    expect(JSON.stringify(failedSecret)).not.toContain("secret-value")
    expect(secretSaved.project_secret_value).toBe("")
    expect(secretSaved.selected_project?.secret_names).toEqual(["OPENAI_API_KEY"])
    expect(JSON.stringify(secretSaved)).not.toContain("secret-value")
    expect(confirmingDelete.pending_secret_delete_name).toBe("OPENAI_API_KEY")
    expect(deleteClickCommands).toEqual([])
    expect(cancelledDelete.pending_secret_delete_name).toBeUndefined()
    expect(cancelCommands).toEqual([])
    expect(deleteCommands.map((command) => command.name)).toEqual(["DeleteProjectSecret"])
    expect(deleteCommands[0]?.args).toEqual({
      api_base_url: "/api/rika",
      project_id: project.project_id,
      name: "OPENAI_API_KEY",
    })
    expect(deletingSecret.pending_secret_delete_name).toBeUndefined()
  })

  test("keeps unrenderable orb change files as skipped rows", () => {
    const [loaded] = update(
      {
        ...initialModel({ api_base_url: "/api/rika" }),
        selected_thread_id: threadId,
        selected_orb: orbSummary("running"),
        threads: [summary(threadId, { orb_status: "running" })],
      },
      LoadedOrbChanges({
        response: {
          base_commit: "abc123",
          head_commit: "def456",
          dirty: true,
          diff: binaryGitPatch("image.bin"),
        },
      }),
    )

    expect(loaded.orb_changes.state).toBe("loaded")
    if (loaded.orb_changes.state !== "loaded") throw new Error("expected loaded changes")
    expect(loaded.orb_changes.diffs).toEqual([
      {
        kind: "skipped",
        payload_id: "orb-changes:0:0",
        file_name: "image.bin",
        reason: "No renderable hunks",
      },
    ])
  })

  test("resets orb tab state when changing thread scope", () => {
    const activeFiles = {
      ...initialModel({ api_base_url: "/api/rika" }),
      selected_thread_id: threadId,
      selected_orb_tab: "files" as const,
      orb_tabs: tabModel(1),
      orb_files: {
        ...initialModel({ api_base_url: "/api/rika" }).orb_files,
        paths: ["README.md"],
        path_kinds: { "README.md": "file" as const },
      },
    }

    const [newThread] = update(activeFiles, ClickedNewThread())
    const [opened] = update(
      activeFiles,
      OpenedThread({ record: { summary: summary(Ids.ThreadId.make("thread-next")), events: [] } }),
    )

    expect(newThread.selected_orb_tab).toBe("transcript")
    expect(newThread.orb_tabs.activeIndex).toBe(0)
    expect(opened.selected_orb_tab).toBe("transcript")
    expect(opened.orb_tabs.activeIndex).toBe(0)
    expect(newThread.orb_files.paths).toEqual([])
    expect(opened.orb_files.paths).toEqual([])
  })

  test("opens a thread from durable events before starting the live subscription", () => {
    const event = messageAdded(4, "assistant", "hello from the CLI")
    const [next, commands] = update(
      initialModel({ api_base_url: "/api/rika" }),
      OpenedThread({ record: { summary: summary(threadId), events: [event] } }),
    )

    expect(commands).toEqual([])
    expect(next.events).toEqual([event])
    expect(next.last_sequence).toBe(4)
    expect(next.subscription_after_sequence).toBe(4)
    expect(next.subscribed_thread_id).toBe(threadId)
    expect(next.connection).toBe("connected")
  })

  test("submitting a turn never appends optimistic transcript events", () => {
    const event = messageAdded(4, "assistant", "already rendered")
    const [opened] = update(
      initialModel({ api_base_url: "/api/rika" }),
      OpenedThread({ record: { summary: summary(threadId), events: [event] } }),
    )
    const [drafted] = update(opened, ChangedDraft({ value: "run tests" }))
    const [next, commands] = update(drafted, SubmittedDraft())

    expect(next.events).toEqual([event])
    expect(next.draft).toBe("")
    expect(next.pending_turn).toBe(true)
    expect(commands.map((command) => command.name)).toEqual(["StartTurn"])
  })

  test("sends user identity on turn submission and returns presence to active", () => {
    const model = {
      ...initialModel({ api_base_url: "/api/rika", user_id: userId }),
      selected_thread_id: threadId,
      subscribed_thread_id: threadId,
      draft: "run tests",
    }

    const [next, commands] = update(model, SubmittedDraft())

    expect(next.draft).toBe("")
    expect(next.pending_turn).toBe(true)
    expect(commands.map((command) => command.name)).toEqual(["SetThreadPresence", "StartTurn"])
    expect(commands[0]?.args).toEqual({
      api_base_url: "/api/rika",
      thread_id: threadId,
      user_id: userId,
      state: "active",
    })
    expect(commands[1]?.args).toEqual({
      api_base_url: "/api/rika",
      thread_id: threadId,
      user_id: userId,
      content: "run tests",
      mode: undefined,
    })
  })

  test("draft input emits a throttled typing presence heartbeat", () => {
    const model = {
      ...initialModel({ api_base_url: "/api/rika", user_id: userId }),
      selected_thread_id: threadId,
      subscribed_thread_id: threadId,
    }

    const [typing, firstCommands] = update(model, ChangedDraft({ value: "h" }))
    const [stillTyping, secondCommands] = update(typing, ChangedDraft({ value: "hi" }))
    const [cleared, clearCommands] = update(stillTyping, ChangedDraft({ value: "" }))
    const [ready] = update(cleared, TypingPresenceReady())
    const [, thirdCommands] = update(ready, ChangedDraft({ value: "hit" }))

    expect(firstCommands.map((command) => command.name)).toEqual(["SetThreadPresence"])
    expect(firstCommands[0]?.args).toEqual({
      api_base_url: "/api/rika",
      thread_id: threadId,
      user_id: userId,
      state: "typing",
    })
    expect(secondCommands).toEqual([])
    expect(clearCommands.map((command) => command.name)).toEqual(["SetThreadPresence"])
    expect(clearCommands[0]?.args).toEqual({
      api_base_url: "/api/rika",
      thread_id: threadId,
      user_id: userId,
      state: "active",
    })
    expect(thirdCommands.map((command) => command.name)).toEqual(["SetThreadPresence"])
  })

  test("submits the selected mode with the next turn without changing the default backend mode", () => {
    const [opened] = update(
      initialModel({ api_base_url: "/api/rika" }),
      OpenedThread({ record: { summary: summary(threadId), events: [] } }),
    )
    const [drafted] = update(opened, ChangedDraft({ value: "run deep" }))
    const [selectedMode] = update(drafted, ChangedDraftMode({ value: "deep2" }))
    const [next, commands] = update(selectedMode, SubmittedDraft())

    expect(initialModel({ api_base_url: "/api/rika" }).draft_mode).toBeUndefined()
    expect(selectedMode.draft_mode).toBe("deep2")
    expect(next.draft).toBe("")
    expect(commands.map((command) => command.name)).toEqual(["StartTurn"])
    expect(commands[0]?.args).toEqual({
      api_base_url: "/api/rika",
      thread_id: threadId,
      content: "run deep",
      mode: "deep2",
    })
  })

  test("interrupts only the active durable turn", () => {
    const turnId = Ids.TurnId.make("turn-web-active")
    const started = turnStarted(4, turnId)
    const model = {
      ...initialModel({ api_base_url: "/api/rika" }),
      selected_thread_id: threadId,
      subscribed_thread_id: threadId,
      events: [started],
      last_sequence: 4,
      subscription_after_sequence: 4,
    }

    const [interrupting, commands] = update(model, ClickedInterrupt())
    const [terminal] = update(interrupting, ReceivedThreadEvent({ event: turnFailed(5, turnId) }))
    const [afterTerminal, terminalCommands] = update(terminal, ClickedInterrupt())

    expect(commands.map((command) => command.name)).toEqual(["InterruptTurn"])
    expect(commands[0]?.args).toEqual({ api_base_url: "/api/rika", thread_id: threadId, turn_id: turnId })
    expect(afterTerminal.events.at(-1)?.type).toBe("turn.failed")
    expect(terminalCommands).toEqual([])
  })

  test("does not send duplicate interrupts while the terminal event is still pending", () => {
    const turnId = Ids.TurnId.make("turn-web-active")
    const model = {
      ...initialModel({ api_base_url: "/api/rika" }),
      selected_thread_id: threadId,
      subscribed_thread_id: threadId,
      events: [turnStarted(4, turnId)],
      last_sequence: 4,
      subscription_after_sequence: 4,
    }

    const [interrupting, firstCommands] = update(model, ClickedInterrupt())
    const [, secondCommands] = update(interrupting, ClickedInterrupt())

    expect(firstCommands.map((command) => command.name)).toEqual(["InterruptTurn"])
    expect(secondCommands).toEqual([])
  })

  test("applies live events once by sequence", () => {
    const event = messageAdded(5, "assistant", "streamed everywhere")
    const model = {
      ...initialModel({ api_base_url: "/api/rika" }),
      selected_thread_id: threadId,
      subscribed_thread_id: threadId,
      last_sequence: 4,
      subscription_after_sequence: 4,
    }

    const [next] = update(model, ReceivedThreadEvent({ event }))
    const [deduped] = update(next, ReceivedThreadEvent({ event }))

    expect(next.events).toEqual([event])
    expect(next.last_sequence).toBe(5)
    expect(deduped.events).toEqual([event])
    expect(deduped.last_sequence).toBe(5)
  })

  test("stores remote presence snapshots without the current user", () => {
    const [next] = update(
      initialModel({ api_base_url: "/api/rika", user_id: userId }),
      ReceivedPresence({
        presence: {
          thread_id: threadId,
          users: [
            { user_id: userId, state: "active", last_seen: 1 },
            { user_id: otherUserId, state: "typing", last_seen: 2 },
          ],
        },
      }),
    )

    expect(next.presence).toEqual([{ user_id: otherUserId, state: "typing", last_seen: 2 }])
  })

  test("renders message events into readable transcript rows", () => {
    expect(eventRows([messageAdded(1, "user", "hi"), messageAdded(2, "assistant", "hello")])).toEqual([
      { id: "event-1", sequence: 1, kind: "message", title: "User", body: "hi" },
      { id: "event-2", sequence: 2, kind: "message", title: "Rika", body: "hello" },
    ])
  })

  test("prefixes other users' message rows with attribution", () => {
    expect(eventRows([messageAdded(1, "user", "hi", otherUserId)], new Set(), userId)).toEqual([
      { id: "event-1", sequence: 1, kind: "message", title: "User", body: "sarah › hi" },
    ])
    expect(eventRows([messageAdded(2, "user", "mine", userId)], new Set(), userId)).toEqual([
      { id: "event-2", sequence: 2, kind: "message", title: "User", body: "mine" },
    ])
  })

  test("renders context compaction into a concise event row", () => {
    expect(eventRows([contextCompacted(3)])).toEqual([
      {
        id: "event-3",
        sequence: 3,
        kind: "event",
        title: "Context compacted",
        body: "manual · tail starts at 2",
      },
    ])
  })

  test("renders context pruning into a concise event row", () => {
    expect(eventRows([contextPruned(4)])).toEqual([
      {
        id: "event-4",
        sequence: 4,
        kind: "event",
        title: "Context pruned",
        body: "2 tools · 24000 tokens",
      },
    ])
  })

  test("renders completed hashline edit Pierre payloads as structured diff rows", () => {
    const payload = pierreDiff("src/app.ts", 2, 1)
    const rows = eventRows([toolCallCompleted(5, "edit", { type: "hashline.edit", diff: payload })])

    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe("pierre-diff")
    expect(rows).not.toContainEqual({
      id: "event-5",
      sequence: 5,
      kind: "tool",
      title: "Tool: edit",
      body: "success",
    })

    const row = rows[0]
    if (row?.kind !== "pierre-diff") throw new Error("expected Pierre diff row")
    expect(row.title).toBe("Tool: edit")
    expect(row.expanded).toBe(false)
    expect(row.diff).toMatchObject({
      payload_id: "event-5:diff:0",
      file_name: "src/app.ts",
      additions: 2,
      deletions: 1,
    })
    expect(row.diff.file_diff).toEqual(payload.file_diff)
  })

  test("renders nested artifact Pierre payloads in encounter order", () => {
    const rows = eventRows([
      artifactCreated(6, {
        sections: [
          { first: pierreDiff("src/first.ts", 1, 0) },
          { nested: { second: pierreDiff("src/second.ts", 0, 2) } },
        ],
      }),
    ])

    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.kind)).toEqual(["pierre-diff", "pierre-diff"])
    expect(rows.map((row) => (row.kind === "pierre-diff" ? row.diff.file_name : row.title))).toEqual([
      "src/first.ts",
      "src/second.ts",
    ])
    expect(rows.map((row) => row.id)).toEqual(["event-6:diff:0", "event-6:diff:1"])
  })

  test("renders malformed Pierre payloads as a fallback row", () => {
    expect(eventRows([toolCallCompleted(7, "edit", { diff: malformedPierreDiff("src/broken.ts") })])).toEqual([
      {
        id: "event-7:diff-unavailable:0",
        sequence: 7,
        kind: "tool",
        title: "Tool: edit",
        body: "src/broken.ts · diff unavailable",
      },
    ])
  })

  test("computes context usage from summary and latest turn events", () => {
    const hidden = initialModel({ api_base_url: "/api/rika" })
    const fromSummary = {
      ...hidden,
      selected_thread_id: threadId,
      threads: [summary(threadId, { context_tokens: 280_000, context_window: 400_000 })],
    }
    const fromEvent = {
      ...fromSummary,
      events: [turnCompletedWithUsage(5, 360_000)],
    }

    expect(contextUsage(hidden)).toBeUndefined()
    expect(contextUsage(fromSummary)).toEqual({ tokens: 280_000, window: 400_000, percent: 70, tone: "warning" })
    expect(contextUsage(fromEvent)).toEqual({ tokens: 360_000, window: 400_000, percent: 90, tone: "danger" })
  })

  test("auto-opens the newest thread after loading the thread list", () => {
    const [next, commands] = update(
      initialModel({ api_base_url: "/api/rika" }),
      LoadedThreads({ threads: [summary(threadId)] }),
    )

    expect(next.selected_thread_id).toBe(threadId)
    expect(commands.map((command) => command.name)).toEqual(["OpenThread"])
  })

  test("clicking a thread resets subscription state until its durable record opens", () => {
    const otherThreadId = Ids.ThreadId.make("thread-other")
    const [model] = update(
      {
        ...initialModel({ api_base_url: "/api/rika" }),
        selected_thread_id: threadId,
        subscribed_thread_id: threadId,
        last_sequence: 9,
        subscription_after_sequence: 9,
      },
      ClickedThread({ thread_id: otherThreadId }),
    )

    expect(model.selected_thread_id).toBe(otherThreadId)
    expect(model.subscribed_thread_id).toBeUndefined()
    expect(model.events).toEqual([])
    expect(model.last_sequence).toBe(0)
  })

  test("opens an orb-backed thread by loading its selected orb summary", () => {
    const [model, commands] = update(
      initialModel({ api_base_url: "/api/rika" }),
      OpenedThread({ record: { summary: summary(threadId, { orb_status: "running" }), events: [] } }),
    )

    expect(model.selected_thread_id).toBe(threadId)
    expect(model.selected_orb).toBeUndefined()
    expect(commands.map((command) => command.name)).toEqual(["LoadSelectedOrb"])
  })

  test("orb lifecycle actions update selected orb state and thread badges", () => {
    const running = orbSummary("running")
    const paused = { ...running, status: "paused" as const }
    const model = {
      ...initialModel({ api_base_url: "/api/rika" }),
      selected_thread_id: threadId,
      selected_orb: running,
      threads: [summary(threadId, { orb_status: "running" })],
    }

    const [requested, commands] = update(model, ClickedPauseOrb())
    const [updated] = update(requested, UpdatedSelectedOrb({ orb: paused }))

    expect(commands.map((command) => command.name)).toEqual(["PauseSelectedOrb"])
    expect(updated.selected_orb).toEqual(paused)
    expect(updated.threads[0]?.orb_status).toBe("paused")
  })

  test("kill requires a confirmation before sending the lifecycle command", () => {
    const running = orbSummary("running")
    const model = {
      ...initialModel({ api_base_url: "/api/rika" }),
      selected_thread_id: threadId,
      selected_orb: running,
      threads: [summary(threadId, { orb_status: "running" })],
    }

    const [confirming, firstCommands] = update(model, ClickedKillOrb())
    const [cancelled] = update(confirming, CancelledKillOrb())
    const [confirmed, secondCommands] = update(confirming, ConfirmedKillOrb())

    expect(firstCommands).toEqual([])
    expect(confirming.confirm_kill_orb_id).toBe(orbId)
    expect(cancelled.confirm_kill_orb_id).toBeUndefined()
    expect(secondCommands.map((command) => command.name)).toEqual(["KillSelectedOrb"])
    expect(confirmed.confirm_kill_orb_id).toBeUndefined()
  })
})

const summary = (id: Ids.ThreadId, input: Partial<Remote.ThreadSummary> = {}): Remote.ThreadSummary => ({
  thread_id: id,
  workspace_id: workspaceId,
  title_text: "Web thread",
  latest_message_text: "Latest",
  diff: { additions: 0, modifications: 0, deletions: 0 },
  archived: false,
  visibility: "private",
  created_at: 1,
  updated_at: 2,
  ...input,
})

const tabModel = (activeIndex: number) => ({
  id: "orb-tabs",
  activeIndex,
  focusedIndex: activeIndex,
  activationMode: "Automatic" as const,
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
  type: "message.added",
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

const contextCompacted = (sequence: number): Event.ContextCompacted => ({
  id: Ids.EventId.make(`event-${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "context.compacted",
  data: {
    summary: "earlier context summary",
    model: "gpt-5.5",
    trigger: "manual",
    tokens_before: 4096,
    tail_start_sequence: 2,
  },
})

const contextPruned = (sequence: number): Event.ContextPruned => ({
  id: Ids.EventId.make(`event-${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "context.pruned",
  data: {
    tool_call_ids: [Ids.ToolCallId.make("tool-web-a"), Ids.ToolCallId.make("tool-web-b")],
    estimated_tokens_freed: 24_000,
  },
})

const turnCompletedWithUsage = (sequence: number, inputTokens: number): Event.TurnCompleted => ({
  id: Ids.EventId.make(`event-${sequence}`),
  thread_id: threadId,
  turn_id: Ids.TurnId.make("turn-web"),
  sequence,
  version: 1,
  created_at: sequence,
  type: "turn.completed",
  data: {
    provider: "openai",
    model: "gpt-5.5",
    usage: { input_tokens: inputTokens, output_tokens: 100, total_tokens: inputTokens + 100 },
  },
})

const toolCallCompleted = (
  sequence: number,
  name: string,
  output: NonNullable<Event.ToolCallCompleted["data"]["result"]["output"]>,
): Event.ToolCallCompleted => ({
  id: Ids.EventId.make(`event-${sequence}`),
  thread_id: threadId,
  turn_id: Ids.TurnId.make("turn-web"),
  sequence,
  version: 1,
  created_at: sequence,
  type: "tool.call.completed",
  data: {
    result: {
      id: Ids.ToolCallId.make(`tool-web-${sequence}`),
      name,
      status: "success",
      output,
    },
  },
})

const artifactCreated = (
  sequence: number,
  content: Event.ArtifactCreated["data"]["artifact"]["content"],
): Event.ArtifactCreated => ({
  id: Ids.EventId.make(`event-${sequence}`),
  thread_id: threadId,
  turn_id: Ids.TurnId.make("turn-web"),
  sequence,
  version: 1,
  created_at: sequence,
  type: "artifact.created",
  data: {
    artifact: {
      id: Ids.ArtifactId.make(`artifact-web-${sequence}`),
      thread_id: threadId,
      turn_id: Ids.TurnId.make("turn-web"),
      kind: "patch",
      title: "Patch bundle",
      content,
      created_at: sequence,
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

const pierreDiff = (name: string, additions: number, deletions: number) => ({
  kind: "diff",
  renderer: "@pierre/diffs",
  collapsed: true,
  file_diff: fileDiff(name, additions, deletions),
})

const malformedPierreDiff = (name: string) => ({
  kind: "diff",
  renderer: "@pierre/diffs",
  file_diff: { name },
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
