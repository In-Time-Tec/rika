import { Common, Ids, Message as RikaMessage, Remote } from "@rika/schema"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Context, Effect, Fiber, Stream } from "effect"
import type { AppMessage as AppMessageType, Model as ModelType } from "../src/app"

const threadId = Ids.ThreadId.make("thread-mount-runtime")
const workspaceId = Ids.WorkspaceId.make("workspace-mount-runtime")
const messageId = Ids.MessageId.make("message-mount-runtime")
const orbId = Ids.OrbId.make("orb-mount-runtime")
const projectId = Ids.ProjectId.make("project-mount-runtime")

let container: HTMLElement

describe("web mount runtime", () => {
  beforeEach(() => {
    GlobalRegistrator.register({ url: "http://localhost:4590", width: 1280, height: 720 })
    container = document.createElement("div")
    document.body.append(container)
  })

  afterEach(async () => {
    document.body.replaceChildren()
    await GlobalRegistrator.unregister()
  })

  test("runs the Pierre tree mount action with Foldkit's captured context", async () => {
    const app = await import("../src/app")
    const messages: Array<AppMessageType> = []
    const model = runtimeMountModel(app.initialModel)
    const action = app.MountPierreTree({
      mount_key: app.pierreTreeMountKey(threadId, orbId),
      paths: model.orb_files.paths,
      selected_path: model.orb_files.selected_path,
      git_status: model.orb_files.git_status,
    })
    const fiber = Effect.runForkWith(Context.empty())(
      action.f(container).pipe(
        Stream.runForEach((message) =>
          Effect.sync(() => {
            messages.push(message)
            app.update(model, message)
          }),
        ),
        Effect.catchCause(() => Effect.void),
      ),
    )

    try {
      await waitFor(
        () => messages.some((message) => message._tag === "RenderedPierreTree"),
        "Pierre tree mount message",
      )
      expect(messages.find((message) => message._tag === "FailedRenderPierreTree")).toBeUndefined()
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber))
    }
  })
})

const runtimeMountModel = (initialModel: (config: { readonly api_base_url: string }) => ModelType): ModelType => ({
  ...initialModel({ api_base_url: "/api/rika" }),
  selected_thread_id: threadId,
  subscribed_thread_id: threadId,
  selected_orb: {
    orb_id: orbId,
    thread_id: threadId,
    project_id: projectId,
    status: "running",
    created_at: Common.TimestampMillis.make(1),
    last_active_at: Common.TimestampMillis.make(2),
    running_minutes: 1,
    base_commit: "abc123",
  },
  selected_orb_tab: "files",
  orb_files: {
    directories: { "": { state: "loaded" } },
    paths: ["src/", "src/app.ts", "README.md"],
    path_kinds: { src: "dir", "src/app.ts": "file", "README.md": "file" },
    selected_path: "README.md",
    git_status: [{ path: "README.md", status: "modified" }],
    opened_file: { state: "idle" },
  },
  events: [
    {
      id: Ids.EventId.make("event-mount-runtime"),
      type: "message.added",
      thread_id: threadId,
      sequence: 1,
      version: 1,
      created_at: Common.TimestampMillis.make(1),
      data: {
        message: {
          id: messageId,
          thread_id: threadId,
          role: "user",
          content: [RikaMessage.text("mount runtime")],
          created_at: Common.TimestampMillis.make(1),
        },
      },
    },
  ],
  threads: [
    {
      thread_id: threadId,
      title_text: "Mount runtime",
      latest_message_text: "mount runtime",
      workspace_id: workspaceId,
      diff: { additions: 0, modifications: 0, deletions: 0 },
      archived: false,
      created_at: Common.TimestampMillis.make(1),
      updated_at: Common.TimestampMillis.make(2),
      orb_status: "running",
      visibility: "private",
    },
  ],
  presence: [] satisfies ReadonlyArray<Remote.PresenceUser>,
})

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${label}`)
}
