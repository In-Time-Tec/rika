import { Event, Ids, Message as RikaMessage, Remote } from "@rika/schema"
import { describe, test } from "bun:test"
import { initialModel, update, type Model, type OrbTab } from "../src/app"

Object.assign(globalThis, {
  window: {
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  },
})

const [Scene, View] = await Promise.all([import("foldkit/scene"), import("../src/view")])

const threadId = Ids.ThreadId.make("thread-view")
const workspaceId = Ids.WorkspaceId.make("workspace-view")
const messageId = Ids.MessageId.make("message-view")
const orbId = Ids.OrbId.make("orb-view")
const projectId = Ids.ProjectId.make("project-view")

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
    )
  })

  test("renders placeholder panels for downstream orb surfaces", () => {
    Scene.scene(
      { update, view: View.view },
      Scene.with(orbModel("files", 1)),
      Scene.expect(Scene.role("tab", { name: "Files", selected: true })).toExist(),
      Scene.expect(Scene.role("tabpanel")).toContainText("Files arrive with #58"),
    )
  })
})

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
})

const messageAdded = (sequence: number, role: RikaMessage.Role, text: string): Event.MessageAdded => ({
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
    },
  },
})
