import { Common, Event, Ids, Message as RikaMessage, Remote } from "@rika/schema"
import { describe, expect, test } from "bun:test"
import {
  ChangedDraft,
  ChangedDraftMode,
  ChangedProjectEnvValue,
  ChangedProjectField,
  ChangedProjectSecretField,
  CancelledDeleteProjectSecret,
  CancelledKillOrb,
  ChangedThreadSearchQuery,
  ChangedThreadSearchWindow,
  ClickedInterrupt,
  ClickedDeleteProjectSecret,
  ClickedProject,
  ClickedProjects,
  ClickedThread,
  ClickedKillOrb,
  ClickedNewThread,
  ClickedPauseOrb,
  ClickedTranscriptDisclosure,
  ConfirmedKillOrb,
  ConfirmedDeleteProjectSecret,
  CreatedThread,
  FailedSaveProject,
  FailedCreateThread,
  FailedOpenThread,
  FailedStartTurn,
  GotOrbTabsMessage,
  LoadedOrbChanges,
  LoadedOrbDirectory,
  LoadedOrbFile,
  LoadedProject,
  LoadedProjects,
  LoadedThreads,
  OpenedThread,
  AcceptedTurn,
  ReceivedThreadEvent,
  ReceivedPresence,
  RequestedTerminalReconnect,
  SavedProject,
  SubmittedProjectSecret,
  SubmittedProjectSettings,
  SelectedOrbFile,
  SubmittedDraft,
  ThreadSubscriptionFailed,
  TypingPresenceReady,
  TerminalFailed,
  TerminalStatusChanged,
  UpdatedSelectedOrb,
  contextUsage,
  eventRows,
  init,
  initialModel,
  InterruptedTurn,
  subscriptions,
  update,
} from "../src/app"
import type { Model } from "../src/app"

const threadId = Ids.ThreadId.make("thread-web")
const alternateThreadId = Ids.ThreadId.make("thread-web-alternate")
const workspaceId = Ids.WorkspaceId.make("workspace-web")
const messageId = Ids.MessageId.make("message-web")
const orbId = Ids.OrbId.make("orb-web")
const projectId = Ids.ProjectId.make("project-web")
const alternateProjectId = Ids.ProjectId.make("project-web-alternate")
const userId = Ids.UserId.make("user_web")
const otherUserId = Ids.UserId.make("sarah")
const searchNow = Common.TimestampMillis.make(2_000_000_000_000)

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
    expect(selectCommands.map((command) => command.name)).toEqual(["UpdatePierreTree", "LoadOrbFile"])
    expect(selectCommands[1]?.args).toEqual({ api_base_url: "/api/rika", thread_id: threadId, path: "README.md" })
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

  test("updates the mounted Pierre tree for file selections and lazy directory loads", () => {
    const model = activeFilesModel()

    const [selected, selectCommands] = update(model, SelectedOrbFile({ path: "README.md" }))
    const [loaded, loadCommands] = update(
      model,
      LoadedOrbDirectory({
        response: {
          path: "src",
          entries: [{ name: "index.ts", path: "src/index.ts", kind: "file", size: 6 }],
        },
      }),
    )

    expect(selected.orb_files.selected_path).toBe("README.md")
    expect(selectCommands.map((command) => command.name)).toEqual(["UpdatePierreTree", "LoadOrbFile"])
    expect(selectCommands[0]?.args).toEqual({
      mount_key: `orb-tree:${threadId}:${orbId}`,
      paths: ["src/", "README.md"],
      selected_path: "README.md",
      git_status: [],
    })
    expect(loaded.orb_files.paths).toEqual(["src/", "README.md", "src/index.ts"])
    expect(loadCommands.map((command) => command.name)).toEqual(["UpdatePierreTree"])
    expect(loadCommands[0]?.args).toEqual({
      mount_key: `orb-tree:${threadId}:${orbId}`,
      paths: ["src/", "README.md", "src/index.ts"],
      git_status: [],
    })
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

  test("derives Pierre tree git status from loaded orb changes", () => {
    const [loaded, commands] = update(
      activeFilesModel(),
      LoadedOrbChanges({
        response: {
          base_commit: "abc123",
          head_commit: "def456",
          dirty: true,
          diff: gitPatch("README.md"),
        },
      }),
    )

    expect(loaded.orb_files.git_status).toEqual([{ path: "README.md", status: "modified" }])
    expect(commands.map((command) => command.name)).toEqual(["UpdatePierreTree"])
    expect(commands[0]?.args).toEqual({
      mount_key: `orb-tree:${threadId}:${orbId}`,
      paths: ["src/", "README.md"],
      git_status: [{ path: "README.md", status: "modified" }],
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
    const [savedWhileDeleteOpen, saveWhileDeleteOpenCommands] = update(
      confirmingDelete,
      SavedProject({ project: savedDetail }),
    )
    const [switchingWhileDeleteOpen, switchWhileDeleteOpenCommands] = update(
      confirmingDelete,
      ClickedProject({ project_id: alternateProjectId }),
    )
    const [cancelledDelete, cancelCommands] = update(confirmingDelete, CancelledDeleteProjectSecret())
    const [confirmingDeleteAgain, deleteClickAgainCommands] = update(
      cancelledDelete,
      ClickedDeleteProjectSecret({ name: "OPENAI_API_KEY" }),
    )
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
    expect(confirmingDelete.delete_secret_dialog.isOpen).toBe(true)
    expect(deleteClickCommands.map((command) => command.name)).toEqual(["ShowDialog"])
    expect(savedWhileDeleteOpen.pending_secret_delete_name).toBeUndefined()
    expect(savedWhileDeleteOpen.delete_secret_dialog.isOpen).toBe(false)
    expect(saveWhileDeleteOpenCommands.map((command) => command.name)).toEqual(["CloseDialog"])
    expect(switchingWhileDeleteOpen.pending_secret_delete_name).toBeUndefined()
    expect(switchingWhileDeleteOpen.delete_secret_dialog.isOpen).toBe(false)
    expect(switchWhileDeleteOpenCommands.map((command) => command.name)).toEqual(["CloseDialog", "LoadProject"])
    expect(cancelledDelete.pending_secret_delete_name).toBeUndefined()
    expect(cancelledDelete.delete_secret_dialog.isOpen).toBe(false)
    expect(cancelCommands.map((command) => command.name)).toEqual(["CloseDialog"])
    expect(deleteClickAgainCommands.map((command) => command.name)).toEqual(["ShowDialog"])
    expect(deleteCommands.map((command) => command.name)).toEqual(["DeleteProjectSecret", "CloseDialog"])
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
        git_status: { path: "image.bin", status: "added" },
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
    const threadNext = Ids.ThreadId.make("thread-next")
    const [opening] = update(activeFiles, ClickedThread({ thread_id: threadNext }))
    const [opened] = update(
      opening,
      OpenedThread({
        record: { summary: summary(threadNext), events: [] },
        request_token: opening.active_thread_request_token ?? 0,
      }),
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
      {
        ...initialModel({ api_base_url: "/api/rika" }),
        selected_thread_id: threadId,
        active_thread_request_token: 1,
      },
      OpenedThread({ record: { summary: summary(threadId), events: [event] }, request_token: 1 }),
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
      {
        ...initialModel({ api_base_url: "/api/rika" }),
        selected_thread_id: threadId,
        active_thread_request_token: 1,
      },
      OpenedThread({ record: { summary: summary(threadId), events: [event] }, request_token: 1 }),
    )
    const [drafted] = update(opened, ChangedDraft({ value: "run tests" }))
    const [next, commands] = update(drafted, SubmittedDraft())

    expect(next.events).toEqual([event])
    expect(next.draft).toBe("")
    expect(next.pending_turn).toBe(true)
    expect(commands.map((command) => command.name)).toEqual(["StartTurn"])
  })

  test("queues the submitted draft when startTurn reports an active user conflict", () => {
    const model = {
      ...initialModel({ api_base_url: "/api/rika", user_id: userId }),
      selected_thread_id: threadId,
      subscribed_thread_id: threadId,
      draft: "queue this",
    }

    const [submitted] = update(model, SubmittedDraft())
    const [conflicted, commands] = update(
      submitted,
      FailedStartTurn({
        thread_id: threadId,
        message: "Another user is running this thread",
        request_token: submitted.active_turn_request_token ?? 0,
        status: 409,
        active_user_id: otherUserId,
      }),
    )

    expect(commands).toEqual([])
    expect(conflicted.pending_turn).toBe(false)
    expect(conflicted.pending_submit).toBeUndefined()
    expect(conflicted.queued_messages).toEqual([{ thread_id: threadId, content: "queue this", mode: undefined }])
    expect(conflicted.notice).toBe("sarah is running a turn - message queued")
  })

  test("queues a stale active-user conflict for the original thread after navigation", () => {
    const model = {
      ...initialModel({ api_base_url: "/api/rika", user_id: userId }),
      selected_thread_id: threadId,
      subscribed_thread_id: threadId,
      draft: "queue after navigation",
    }

    const [submitted] = update(model, SubmittedDraft())
    const requestToken = submitted.active_turn_request_token ?? 0
    const [openingOther] = update(submitted, ClickedThread({ thread_id: alternateThreadId }))
    const [conflicted, commands] = update(
      openingOther,
      FailedStartTurn({
        thread_id: threadId,
        message: "Another user is running this thread",
        request_token: requestToken,
        status: 409,
        active_user_id: otherUserId,
      }),
    )

    expect(commands).toEqual([])
    expect(conflicted.selected_thread_id).toBe(alternateThreadId)
    expect(conflicted.pending_turn).toBe(false)
    expect(conflicted.pending_submit).toBeUndefined()
    expect(conflicted.queued_messages).toEqual([
      { thread_id: threadId, content: "queue after navigation", mode: undefined },
    ])
    expect(conflicted.notice).toBe("sarah is running a turn - message queued")
  })

  test("drains queued messages after the active turn completes", () => {
    const turnId = Ids.TurnId.make("turn-web-active")
    const model = {
      ...initialModel({ api_base_url: "/api/rika", user_id: userId }),
      selected_thread_id: threadId,
      subscribed_thread_id: threadId,
      events: [turnStarted(4, turnId)],
      last_sequence: 4,
      subscription_after_sequence: 4,
      queued_messages: [{ thread_id: threadId, content: "queued follow-up", mode: "smart" as const }],
    }

    const [next, commands] = update(model, ReceivedThreadEvent({ event: turnCompleted(5, turnId) }))

    expect(next.queued_messages).toEqual([])
    expect(next.pending_turn).toBe(true)
    expect(next.pending_submit).toBe("queued follow-up")
    expect(commands.map((command) => command.name)).toEqual(["SetThreadPresence", "StartTurn"])
    expect(commands.at(-1)?.args).toEqual({
      api_base_url: "/api/rika",
      thread_id: threadId,
      user_id: userId,
      content: "queued follow-up",
      mode: "smart",
      request_token: 1,
    })
  })

  test("queues a stale drained-message conflict for the original thread after navigation", () => {
    const turnId = Ids.TurnId.make("turn-web-active")
    const model = {
      ...initialModel({ api_base_url: "/api/rika", user_id: userId }),
      selected_thread_id: threadId,
      subscribed_thread_id: threadId,
      events: [turnStarted(4, turnId)],
      last_sequence: 4,
      subscription_after_sequence: 4,
      queued_messages: [{ thread_id: threadId, content: "queued drain", mode: "smart" as const }],
    }

    const [drained] = update(model, ReceivedThreadEvent({ event: turnCompleted(5, turnId) }))
    const requestToken = drained.active_turn_request_token ?? 0
    const [openingOther] = update(drained, ClickedThread({ thread_id: alternateThreadId }))
    const [conflicted] = update(
      openingOther,
      FailedStartTurn({
        thread_id: threadId,
        message: "Another user is running this thread",
        request_token: requestToken,
        status: 409,
        active_user_id: otherUserId,
      }),
    )

    expect(conflicted.selected_thread_id).toBe(alternateThreadId)
    expect(conflicted.pending_submit).toBeUndefined()
    expect(conflicted.queued_messages).toEqual([{ thread_id: threadId, content: "queued drain", mode: "smart" }])
    expect(conflicted.notice).toBe("sarah is running a turn - message queued")
  })

  test("keeps queued conflict messages scoped to their original thread", () => {
    const activeTurnId = Ids.TurnId.make("turn-web-active")
    const otherTurnId = Ids.TurnId.make("turn-web-other")
    const model = {
      ...initialModel({ api_base_url: "/api/rika", user_id: userId }),
      selected_thread_id: threadId,
      subscribed_thread_id: threadId,
      draft: "draft for A",
    }

    const [submitted] = update(model, SubmittedDraft())
    const [conflicted] = update(
      submitted,
      FailedStartTurn({
        thread_id: threadId,
        message: "Another user is running this thread",
        request_token: submitted.active_turn_request_token ?? 0,
        status: 409,
        active_user_id: otherUserId,
      }),
    )
    const [openingOther] = update(conflicted, ClickedThread({ thread_id: alternateThreadId }))
    const [openedOther] = update(
      openingOther,
      OpenedThread({
        record: { summary: summary(alternateThreadId), events: [] },
        request_token: openingOther.active_thread_request_token ?? 0,
      }),
    )
    const [otherCompleted, otherCommands] = update(
      openedOther,
      ReceivedThreadEvent({ event: turnCompleted(1, otherTurnId, alternateThreadId) }),
    )
    const [openingOriginal] = update(otherCompleted, ClickedThread({ thread_id: threadId }))
    const [reopenedOriginal, originalCommands] = update(
      openingOriginal,
      OpenedThread({
        record: { summary: summary(threadId), events: [turnStarted(2, activeTurnId), turnCompleted(3, activeTurnId)] },
        request_token: openingOriginal.active_thread_request_token ?? 0,
      }),
    )

    expect(otherCommands).toEqual([])
    expect(otherCompleted.queued_messages).toEqual([{ thread_id: threadId, content: "draft for A", mode: undefined }])
    expect(reopenedOriginal.queued_messages).toEqual([])
    expect(originalCommands.map((command) => command.name)).toEqual(["SetThreadPresence", "StartTurn"])
    expect(originalCommands.at(-1)?.args).toEqual({
      api_base_url: "/api/rika",
      thread_id: threadId,
      user_id: userId,
      content: "draft for A",
      mode: undefined,
      request_token: 2,
    })
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
      request_token: 1,
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
      {
        ...initialModel({ api_base_url: "/api/rika" }),
        selected_thread_id: threadId,
        active_thread_request_token: 1,
      },
      OpenedThread({ record: { summary: summary(threadId), events: [] }, request_token: 1 }),
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
      request_token: 1,
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

  test("treats a completed interrupt response as benign", () => {
    const turnId = Ids.TurnId.make("turn-web-active")
    const completed = turnCompleted(5, turnId)
    const model = {
      ...initialModel({ api_base_url: "/api/rika" }),
      selected_thread_id: threadId,
      subscribed_thread_id: threadId,
      events: [turnStarted(4, turnId), completed],
      last_sequence: 5,
      subscription_after_sequence: 5,
      pending_interrupt_turn_id: turnId,
    }

    const [next, commands] = update(model, InterruptedTurn({ event: completed }))

    expect(next.pending_interrupt_turn_id).toBeUndefined()
    expect(next.notice).toBeUndefined()
    expect(next.events).toEqual(model.events)
    expect(commands).toEqual([])
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

  test("folds consecutive stream chunks into a single message row", () => {
    expect(eventRows([streamChunk(1, "Hello world. "), streamChunk(2, "Second sentence.")])).toEqual([
      { id: "event-1", sequence: 1, kind: "message", title: "Rika", body: "Hello world. Second sentence." },
    ])
  })

  test("supersedes streamed chunks with the final assistant message of the turn", () => {
    const turnId = Ids.TurnId.make("turn-web")
    expect(
      eventRows([
        streamChunk(1, "Hello ", turnId),
        streamChunk(2, "world.", turnId),
        messageAdded(3, "assistant", "Hello world.", undefined, turnId),
      ]),
    ).toEqual([{ id: "event-3", sequence: 3, kind: "message", title: "Rika", body: "Hello world." }])
  })

  test("keeps pre-tool prose when the final message supersedes only trailing chunks", () => {
    const turnId = Ids.TurnId.make("turn-web")
    const rows = eventRows([
      streamChunk(1, "Let me ", turnId),
      streamChunk(2, "check.", turnId),
      toolCallRequested(3, "read"),
      streamChunk(4, "Here is ", turnId),
      streamChunk(5, "the answer.", turnId),
      messageAdded(6, "assistant", "Here is the answer.", undefined, turnId),
    ])

    expect(rows.map((row) => [row.id, row.kind, "body" in row ? row.body : ""])).toEqual([
      ["event-1", "message", "Let me check."],
      ["event-3", "tool", "Running"],
      ["event-6", "message", "Here is the answer."],
    ])
  })

  test("folds interleaved reasoning deltas without splitting the content bubble", () => {
    const rows = eventRows([
      streamChunk(1, "First "),
      reasoningDelta(2, "thinking "),
      streamChunk(3, "and second."),
      reasoningDelta(4, "more."),
    ])

    expect(rows).toEqual([
      { id: "event-1", sequence: 1, kind: "message", title: "Rika", body: "First and second." },
      { id: "event-2", sequence: 2, kind: "event", title: "Reasoning", body: "thinking more.", is_open: true },
    ])
  })

  test("retains partial streamed text when the turn fails", () => {
    const turnId = Ids.TurnId.make("turn-web")
    const rows = eventRows([streamChunk(1, "Partial ", turnId), streamChunk(2, "reply", turnId), turnFailed(3, turnId)])

    expect(rows.map((row) => [row.id, row.kind, "body" in row ? row.body : ""])).toEqual([
      ["event-1", "message", "Partial reply"],
      ["event-3", "error", "cancelled"],
    ])
  })

  test("folds tool input deltas and removes them once input ends", () => {
    const streaming = eventRows([
      toolInputStarted(1, "write"),
      toolInputDelta(2, "tool-web-1", '{"path":'),
      toolInputDelta(3, "tool-web-1", '"a.ts"}'),
    ])
    expect(streaming.map((row) => [row.id, "body" in row ? row.body : ""])).toEqual([
      ["event-1", "Started"],
      ["event-2", '{"path":"a.ts"}'],
    ])

    const ended = eventRows([
      toolInputStarted(1, "write"),
      toolInputDelta(2, "tool-web-1", '{"path":'),
      toolInputDelta(3, "tool-web-1", '"a.ts"}'),
      toolInputEnded(4, "tool-web-1", "write", '{"path":"a.ts"}'),
    ])
    expect(ended.map((row) => [row.id, "body" in row ? row.body : ""])).toEqual([
      ["event-1", "Started"],
      ["event-4", '{"path":"a.ts"}'],
    ])
  })

  test("does not cross-fold chunks from different turns", () => {
    const firstTurn = Ids.TurnId.make("turn-web-a")
    const secondTurn = Ids.TurnId.make("turn-web-b")
    const rows = eventRows([
      streamChunk(1, "First turn.", firstTurn),
      turnCompleted(2, firstTurn),
      streamChunk(3, "Second turn.", secondTurn),
    ])

    expect(rows.map((row) => [row.id, row.kind, "body" in row ? row.body : ""])).toEqual([
      ["event-1", "message", "First turn."],
      ["event-3", "message", "Second turn."],
    ])
  })

  test("keeps user message attribution separate from body text", () => {
    expect(eventRows([messageAdded(1, "user", "hi", otherUserId)], new Set(), userId)).toEqual([
      {
        id: "event-1",
        sequence: 1,
        kind: "message",
        title: "User",
        body: "hi",
        author: { label: "sarah", is_local: false },
      },
    ])
    expect(eventRows([messageAdded(2, "user", "mine", userId)], new Set(), userId)).toEqual([
      {
        id: "event-2",
        sequence: 2,
        kind: "message",
        title: "User",
        body: "mine",
        author: { label: "User", is_local: true },
      },
    ])
  })

  test("toggles transcript disclosure rows by row id", () => {
    const [collapsed] = update(
      initialModel({ api_base_url: "/api/rika" }),
      ClickedTranscriptDisclosure({ row_id: "event-1" }),
    )
    const [expanded] = update(collapsed, ClickedTranscriptDisclosure({ row_id: "event-1" }))

    expect(collapsed.collapsed_transcript_row_ids).toEqual(["event-1"])
    expect(expanded.collapsed_transcript_row_ids).toEqual([])
    expect(
      eventRows(
        [reasoningDelta(1, "checking files")],
        new Set(),
        userId,
        new Set(collapsed.collapsed_transcript_row_ids),
      ),
    ).toEqual([
      {
        id: "event-1",
        sequence: 1,
        kind: "event",
        title: "Reasoning",
        body: "checking files",
        is_open: false,
      },
    ])
    expect(
      eventRows([toolInputStarted(1, "write")], new Set(), userId, new Set(collapsed.collapsed_transcript_row_ids)),
    ).toEqual([
      {
        id: "event-1",
        sequence: 1,
        kind: "tool",
        title: "Tool input: write",
        body: "Started",
        is_open: false,
      },
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
        is_open: true,
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

  test("searches threads with the sidebar query and time window", () => {
    const [searched, searchCommands] = update(
      initialModel({ api_base_url: "/api/rika" }),
      ChangedThreadSearchQuery({ value: "file:src/app.ts auth", now: searchNow }),
    )
    const [windowed, windowCommands] = update(searched, ChangedThreadSearchWindow({ value: "24h", now: searchNow }))
    const [loaded] = update(windowed, LoadedThreads({ threads: [summary(threadId)] }))

    expect(searched.thread_search_query).toBe("file:src/app.ts auth")
    expect(searchCommands.map((command) => command.name)).toEqual(["SearchThreads"])
    expect(searchCommands[0]?.args).toEqual({
      api_base_url: "/api/rika",
      query: "file:src/app.ts auth",
      window: "all",
      now: searchNow,
    })
    expect(windowed.thread_search_window).toBe("24h")
    expect(windowCommands.map((command) => command.name)).toEqual(["SearchThreads"])
    expect(windowCommands[0]?.args).toEqual({
      api_base_url: "/api/rika",
      query: "file:src/app.ts auth",
      window: "24h",
      now: searchNow,
    })
    expect(loaded.threads.map((thread) => thread.thread_id)).toEqual([threadId])
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

  test("ignores a stale opened thread response after a newer thread is selected", () => {
    const [openingFirst] = update(initialModel({ api_base_url: "/api/rika" }), ClickedThread({ thread_id: threadId }))
    const [openingSecond] = update(openingFirst, ClickedThread({ thread_id: alternateThreadId }))
    const [stale] = update(
      openingSecond,
      OpenedThread({
        record: { summary: summary(threadId), events: [messageAdded(3, "assistant", "stale")] },
        request_token: 1,
      }),
    )

    expect(stale.selected_thread_id).toBe(alternateThreadId)
    expect(stale.subscribed_thread_id).toBeUndefined()
    expect(stale.events).toEqual([])
    expect(stale.last_sequence).toBe(0)
  })

  test("ignores a stale opened thread response from an older request for the same selected thread", () => {
    const model = {
      ...initialModel({ api_base_url: "/api/rika" }),
      selected_thread_id: threadId,
      active_thread_request_token: 3,
    } as ReturnType<typeof initialModel>
    const [stale] = update(
      model,
      OpenedThread({
        record: { summary: summary(threadId), events: [messageAdded(3, "assistant", "stale")] },
        request_token: 1,
      }),
    )

    expect(stale.subscribed_thread_id).toBeUndefined()
    expect(stale.events).toEqual([])
    expect(stale.last_sequence).toBe(0)
  })

  test("ignores a stale opened thread response after starting a new thread request", () => {
    const [openingFirst] = update(initialModel({ api_base_url: "/api/rika" }), ClickedThread({ thread_id: threadId }))
    const [creating] = update(openingFirst, ClickedNewThread())
    const [stale] = update(
      creating,
      OpenedThread({
        record: { summary: summary(threadId), events: [messageAdded(3, "assistant", "stale")] },
        request_token: 1,
      }),
    )

    expect(stale.selected_thread_id).toBeUndefined()
    expect(stale.subscribed_thread_id).toBeUndefined()
    expect(stale.creating_thread).toBe(true)
    expect(stale.events).toEqual([])
  })

  test("does not auto-open loaded threads while a new thread request is active", () => {
    const createdThreadId = Ids.ThreadId.make("thread-created-current")
    const [creating] = update(initialModel({ api_base_url: "/api/rika" }), ClickedNewThread())
    const requestToken = creating.active_thread_request_token ?? 0
    const [listed, listCommands] = update(creating, LoadedThreads({ threads: [summary(threadId)] }))
    const [created] = update(listed, CreatedThread({ summary: summary(createdThreadId), request_token: requestToken }))

    expect(listCommands).toEqual([])
    expect(listed.selected_thread_id).toBeUndefined()
    expect(listed.creating_thread).toBe(true)
    expect(listed.active_thread_request_token).toBe(requestToken)
    expect(created.selected_thread_id).toBe(createdThreadId)
    expect(created.subscribed_thread_id).toBe(createdThreadId)
  })

  test("ignores stale open and create failures from older thread requests", () => {
    const [openingFirst] = update(initialModel({ api_base_url: "/api/rika" }), ClickedThread({ thread_id: threadId }))
    const [openingSecond] = update(openingFirst, ClickedThread({ thread_id: alternateThreadId }))
    const [staleOpenFailure] = update(openingSecond, FailedOpenThread({ message: "old open failed", request_token: 1 }))
    const creating = {
      ...initialModel({ api_base_url: "/api/rika" }),
      creating_thread: true,
      active_thread_request_token: 2,
      connection: "loading" as const,
    } as ReturnType<typeof initialModel>
    const [staleCreateFailure] = update(
      creating,
      FailedCreateThread({ message: "old create failed", request_token: 1 }),
    )

    expect(staleOpenFailure.selected_thread_id).toBe(alternateThreadId)
    expect(staleOpenFailure.connection).toBe("loading")
    expect(staleOpenFailure.notice).toBeUndefined()
    expect(staleCreateFailure.creating_thread).toBe(true)
    expect(staleCreateFailure.connection).toBe("loading")
    expect(staleCreateFailure.notice).toBeUndefined()
  })

  test("ignores a stale created thread response after selecting an existing thread", () => {
    const createdThreadId = Ids.ThreadId.make("thread-created-stale")
    const [creating] = update(initialModel({ api_base_url: "/api/rika" }), ClickedNewThread())
    const [openingExisting] = update(creating, ClickedThread({ thread_id: alternateThreadId }))
    const [stale] = update(openingExisting, CreatedThread({ summary: summary(createdThreadId), request_token: 1 }))

    expect(stale.selected_thread_id).toBe(alternateThreadId)
    expect(stale.subscribed_thread_id).toBeUndefined()
    expect(stale.events).toEqual([])
  })

  test("ignores a stale created thread response from an older create request", () => {
    const createdThreadId = Ids.ThreadId.make("thread-created-stale")
    const model = {
      ...initialModel({ api_base_url: "/api/rika" }),
      creating_thread: true,
      active_thread_request_token: 2,
    } as ReturnType<typeof initialModel>
    const [stale] = update(model, CreatedThread({ summary: summary(createdThreadId), request_token: 1 }))

    expect(stale.selected_thread_id).toBeUndefined()
    expect(stale.subscribed_thread_id).toBeUndefined()
    expect(stale.creating_thread).toBe(true)
  })

  test("ignores a stale accepted turn while a newer new-thread submission is pending", () => {
    const model = {
      ...initialModel({ api_base_url: "/api/rika" }),
      pending_turn: true,
      pending_submit: "new message",
      active_turn_request_token: 2,
      connection: "loading" as const,
    } as ReturnType<typeof initialModel>
    const [stale] = update(model, AcceptedTurn({ response: { thread_id: threadId, accepted: true }, request_token: 1 }))

    expect(stale.pending_submit).toBe("new message")
    expect(stale.pending_turn).toBe(true)
    expect(stale.connection).toBe("loading")
  })

  test("changes subscription dependencies after a thread event stream failure", () => {
    const model = {
      ...initialModel({ api_base_url: "/api/rika", user_id: userId }),
      selected_thread_id: threadId,
      subscribed_thread_id: threadId,
      last_sequence: 4,
      subscription_after_sequence: 4,
    }
    const before = subscriptions.threadEvents.modelToDependencies(model)
    const [failed] = update(model, ThreadSubscriptionFailed({ message: "socket closed" }))
    const after = subscriptions.threadEvents.modelToDependencies(failed)

    expect(after).not.toEqual(before)
    expect(after.thread_id).toBe(threadId)
    expect(after.after_sequence).toBe(4)
    expect(after.retry).toBe(1)
  })

  test("opens an orb-backed thread by loading its selected orb summary", () => {
    const [model, commands] = update(
      {
        ...initialModel({ api_base_url: "/api/rika" }),
        selected_thread_id: threadId,
        active_thread_request_token: 1,
      },
      OpenedThread({
        record: { summary: summary(threadId, { orb_status: "running" }), events: [] },
        request_token: 1,
      }),
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
    const paused = { ...running, status: "paused" as const }
    const killed = { ...running, status: "killed" as const }
    const model = {
      ...initialModel({ api_base_url: "/api/rika" }),
      selected_thread_id: threadId,
      selected_orb: running,
      threads: [summary(threadId, { orb_status: "running" })],
    }

    const [confirming, firstCommands] = update(model, ClickedKillOrb())
    const [refreshed, refreshCommands] = update(confirming, UpdatedSelectedOrb({ orb: paused }))
    const [cancelled, cancelCommands] = update(confirming, CancelledKillOrb())
    const [confirmed, secondCommands] = update(confirming, ConfirmedKillOrb())
    const [killedRefresh, killedRefreshCommands] = update(confirming, UpdatedSelectedOrb({ orb: killed }))
    const [confirmedAfterKilled, confirmedAfterKilledCommands] = update(killedRefresh, ConfirmedKillOrb())

    expect(firstCommands.map((command) => command.name)).toEqual(["ShowDialog"])
    expect(confirming.confirm_kill_orb_id).toBe(orbId)
    expect(confirming.kill_orb_dialog.isOpen).toBe(true)
    expect(refreshed.confirm_kill_orb_id).toBe(orbId)
    expect(refreshed.kill_orb_dialog.isOpen).toBe(true)
    expect(refreshCommands).toEqual([])
    expect(cancelled.confirm_kill_orb_id).toBeUndefined()
    expect(cancelled.kill_orb_dialog.isOpen).toBe(false)
    expect(cancelCommands.map((command) => command.name)).toEqual(["CloseDialog"])
    expect(secondCommands.map((command) => command.name)).toEqual(["KillSelectedOrb", "CloseDialog"])
    expect(confirmed.confirm_kill_orb_id).toBeUndefined()
    expect(killedRefresh.confirm_kill_orb_id).toBeUndefined()
    expect(killedRefresh.kill_orb_dialog.isOpen).toBe(false)
    expect(killedRefreshCommands.map((command) => command.name)).toEqual(["CloseDialog"])
    expect(confirmedAfterKilled).toBe(killedRefresh)
    expect(confirmedAfterKilledCommands).toEqual([])
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

const activeFilesModel = (): Model => ({
  ...initialModel({ api_base_url: "/api/rika" }),
  selected_thread_id: threadId,
  selected_orb: orbSummary("running"),
  selected_orb_tab: "files",
  orb_tabs: tabModel(1),
  threads: [summary(threadId, { orb_status: "running" })],
  orb_files: {
    ...initialModel({ api_base_url: "/api/rika" }).orb_files,
    directories: { "": { state: "loaded" } },
    paths: ["src/", "README.md"],
    path_kinds: { src: "dir", "README.md": "file" },
  },
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
  turnId?: Ids.TurnId,
): Event.MessageAdded => ({
  id: Ids.EventId.make(`event-${sequence}`),
  thread_id: threadId,
  ...(turnId === undefined ? {} : { turn_id: turnId }),
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

const streamChunk = (
  sequence: number,
  text: string,
  turnId: Ids.TurnId = Ids.TurnId.make("turn-web"),
): Event.ModelStreamChunk => ({
  id: Ids.EventId.make(`event-${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "model.stream.chunk",
  data: { text, provider: "openai", model: "gpt-5.5" },
})

const toolCallRequested = (sequence: number, name: string): Event.ToolCallRequested => ({
  id: Ids.EventId.make(`event-${sequence}`),
  thread_id: threadId,
  turn_id: Ids.TurnId.make("turn-web"),
  sequence,
  version: 1,
  created_at: sequence,
  type: "tool.call.requested",
  data: { call: { id: Ids.ToolCallId.make(`tool-web-${sequence}`), name, input: {} } },
})

const toolInputDelta = (sequence: number, toolCallId: string, text: string): Event.ToolCallInputDelta => ({
  id: Ids.EventId.make(`event-${sequence}`),
  thread_id: threadId,
  turn_id: Ids.TurnId.make("turn-web"),
  sequence,
  version: 1,
  created_at: sequence,
  type: "tool.call.input.delta",
  data: { id: Ids.ToolCallId.make(toolCallId), text },
})

const toolInputEnded = (
  sequence: number,
  toolCallId: string,
  name: string,
  inputText: string,
): Event.ToolCallInputEnded => ({
  id: Ids.EventId.make(`event-${sequence}`),
  thread_id: threadId,
  turn_id: Ids.TurnId.make("turn-web"),
  sequence,
  version: 1,
  created_at: sequence,
  type: "tool.call.input.ended",
  data: { id: Ids.ToolCallId.make(toolCallId), name, input_text: inputText },
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

const reasoningDelta = (sequence: number, text: string): Event.ModelReasoningDelta => ({
  id: Ids.EventId.make(`event-${sequence}`),
  thread_id: threadId,
  turn_id: Ids.TurnId.make("turn-web"),
  sequence,
  version: 1,
  created_at: sequence,
  type: "model.reasoning.delta",
  data: { text, provider: "openai", model: "gpt-5.5" },
})

const toolInputStarted = (sequence: number, name: string): Event.ToolCallInputStarted => ({
  id: Ids.EventId.make(`event-${sequence}`),
  thread_id: threadId,
  turn_id: Ids.TurnId.make("turn-web"),
  sequence,
  version: 1,
  created_at: sequence,
  type: "tool.call.input.started",
  data: {
    id: Ids.ToolCallId.make(`tool-web-${sequence}`),
    name,
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

const turnStarted = (
  sequence: number,
  turnId: Ids.TurnId,
  eventThreadId: Ids.ThreadId = threadId,
): Event.TurnStarted => ({
  id: Ids.EventId.make(`event-${sequence}`),
  thread_id: eventThreadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "turn.started",
  data: {},
})

const turnCompleted = (
  sequence: number,
  turnId: Ids.TurnId,
  eventThreadId: Ids.ThreadId = threadId,
): Event.TurnCompleted => ({
  id: Ids.EventId.make(`event-${sequence}`),
  thread_id: eventThreadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "turn.completed",
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
