import { describe, expect, test } from "bun:test"
import { Config, Time } from "@rika/core"
import { Database, Migration, ThreadEventLog, ThreadProjection, WorkspaceStore } from "@rika/persistence"
import { Common, Event, Ids, Workspace } from "@rika/schema"
import { Effect, Layer } from "effect"
import { WorkspaceAccess } from "../src/index"

const workspaceId = Ids.WorkspaceId.make("workspace_access")
const otherWorkspaceId = Ids.WorkspaceId.make("workspace_access_other")
const ownerId = Ids.UserId.make("user_access_owner")
const memberId = Ids.UserId.make("user_access_member")
const outsiderId = Ids.UserId.make("user_access_outsider")
const threadId = Ids.ThreadId.make("thread_access")
const now = Common.TimestampMillis.make(1_990_000_000_000)

const configLayer = Config.layerFromValues({
  workspace_root: "/workspace/rika-access-test",
  data_dir: "/workspace/rika-access-test/.rika",
  default_mode: "smart",
})
const databaseLayer = Database.memoryLayer
const timeLayer = Time.fixedLayer(now)
const storeLayer = WorkspaceStore.layer.pipe(Layer.provideMerge(databaseLayer))
const accessLayer = WorkspaceAccess.layer.pipe(
  Layer.provideMerge(databaseLayer),
  Layer.provideMerge(ThreadProjection.layer),
  Layer.provideMerge(storeLayer),
  Layer.provideMerge(timeLayer),
)
const layer = Layer.mergeAll(
  configLayer,
  databaseLayer,
  Migration.layer,
  ThreadEventLog.layer,
  ThreadProjection.layer,
  storeLayer,
  timeLayer,
  accessLayer,
)

describe("WorkspaceAccess", () => {
  test("allows local mode without a user identity", async () => {
    const decision = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* WorkspaceAccess.authorizeWorkspace({ workspace_id: workspaceId, action: "write" })
      }).pipe(Effect.provide(layer)),
    )

    expect(decision).toEqual({ allowed: true, action: "write", workspace_id: workspaceId })
  })

  test("enforces member and owner role boundaries", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* WorkspaceStore.putMembership(membership(ownerId, "owner", workspaceId))
        yield* WorkspaceStore.putMembership(membership(memberId, "member", workspaceId))
        const ownerAdmin = yield* WorkspaceAccess.authorizeWorkspace({
          workspace_id: workspaceId,
          user_id: ownerId,
          action: "admin",
        })
        const memberWrite = yield* WorkspaceAccess.authorizeWorkspace({
          workspace_id: workspaceId,
          user_id: memberId,
          action: "write",
        })
        const memberAdmin = yield* WorkspaceAccess.authorizeWorkspace({
          workspace_id: workspaceId,
          user_id: memberId,
          action: "admin",
        })
        const outsiderRead = yield* WorkspaceAccess.authorizeWorkspace({
          workspace_id: workspaceId,
          user_id: outsiderId,
          action: "read",
        })
        return { ownerAdmin, memberWrite, memberAdmin, outsiderRead }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.ownerAdmin.allowed).toBe(true)
    expect(result.memberWrite.allowed).toBe(true)
    expect(result.memberAdmin.allowed).toBe(false)
    expect(result.outsiderRead.allowed).toBe(false)
  })

  test("checks thread access through the thread workspace projection", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* appendProjected(threadCreated())
        yield* appendProjected(threadVisibilitySetForThread())
        yield* WorkspaceStore.putMembership(membership(memberId, "member", workspaceId))
        const memberRead = yield* WorkspaceAccess.authorizeThread({
          thread_id: threadId,
          user_id: memberId,
          action: "read",
        })
        const outsiderRead = yield* WorkspaceAccess.authorizeThread({
          thread_id: threadId,
          user_id: outsiderId,
          action: "read",
        })
        const summaries = yield* ThreadProjection.listThreads()
        const readable = yield* WorkspaceAccess.filterReadableThreads(summaries, memberId)
        return { memberRead, outsiderRead, readable }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.memberRead.allowed).toBe(true)
    expect(result.outsiderRead.allowed).toBe(false)
    expect(result.readable.map((summary) => summary.thread_id)).toEqual([threadId])
  })

  test("enforces thread visibility for creator, members, outsiders, and local no-user reads", async () => {
    const decisions = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* WorkspaceStore.putMembership(membership(ownerId, "owner", workspaceId))
        yield* WorkspaceStore.putMembership(membership(memberId, "member", workspaceId))

        for (const visibility of ["private", "workspace", "unlisted"] as const) {
          yield* appendProjected(threadCreatedFor(visibility))
          if (visibility !== "private") yield* appendProjected(threadVisibilitySet(visibility))
        }

        const matrix = new Map<string, boolean>()
        for (const visibility of ["private", "workspace", "unlisted"] as const) {
          const id = visibilityThreadId(visibility)
          for (const [label, user_id] of [
            ["creator", ownerId],
            ["member", memberId],
            ["outsider", outsiderId],
          ] as const) {
            const decision = yield* WorkspaceAccess.authorizeThread({ thread_id: id, user_id, action: "read" })
            matrix.set(`${visibility}:${label}`, decision.allowed)
          }
          const local = yield* WorkspaceAccess.authorizeThread({ thread_id: id, action: "read" })
          matrix.set(`${visibility}:local`, local.allowed)
        }

        const summaries = yield* ThreadProjection.listThreads()
        const memberReadable = yield* WorkspaceAccess.filterReadableThreads(summaries, memberId)
        const outsiderReadable = yield* WorkspaceAccess.filterReadableThreads(summaries, outsiderId)
        const localReadable = yield* WorkspaceAccess.filterReadableThreads(summaries)
        const ownerDiscoverable = yield* WorkspaceAccess.filterDiscoverableThreads(summaries, ownerId)
        const memberDiscoverable = yield* WorkspaceAccess.filterDiscoverableThreads(summaries, memberId)
        const outsiderDiscoverable = yield* WorkspaceAccess.filterDiscoverableThreads(summaries, outsiderId)
        const creatorPrivateWrite = yield* WorkspaceAccess.authorizeThread({
          thread_id: visibilityThreadId("private"),
          user_id: ownerId,
          action: "write",
        })
        const memberPrivateWrite = yield* WorkspaceAccess.authorizeThread({
          thread_id: visibilityThreadId("private"),
          user_id: memberId,
          action: "write",
        })
        return {
          matrix,
          memberReadable,
          outsiderReadable,
          localReadable,
          ownerDiscoverable,
          memberDiscoverable,
          outsiderDiscoverable,
          creatorPrivateWrite,
          memberPrivateWrite,
        }
      }).pipe(Effect.provide(layer)),
    )

    expect(Object.fromEntries(decisions.matrix)).toEqual({
      "private:creator": true,
      "private:member": false,
      "private:outsider": false,
      "private:local": true,
      "workspace:creator": true,
      "workspace:member": true,
      "workspace:outsider": false,
      "workspace:local": true,
      "unlisted:creator": true,
      "unlisted:member": true,
      "unlisted:outsider": true,
      "unlisted:local": true,
    })
    expect(decisions.memberReadable.map((summary) => summary.thread_id).toSorted()).toEqual([
      visibilityThreadId("unlisted"),
      visibilityThreadId("workspace"),
    ])
    expect(decisions.outsiderReadable.map((summary) => summary.thread_id)).toEqual([visibilityThreadId("unlisted")])
    expect(decisions.localReadable.map((summary) => summary.thread_id).toSorted()).toEqual([
      visibilityThreadId("private"),
      visibilityThreadId("unlisted"),
      visibilityThreadId("workspace"),
    ])
    expect(decisions.ownerDiscoverable.map((summary) => summary.thread_id).toSorted()).toEqual([
      visibilityThreadId("private"),
      visibilityThreadId("unlisted"),
      visibilityThreadId("workspace"),
    ])
    expect(decisions.memberDiscoverable.map((summary) => summary.thread_id)).toEqual([visibilityThreadId("workspace")])
    expect(decisions.outsiderDiscoverable).toEqual([])
    expect(decisions.creatorPrivateWrite.allowed).toBe(true)
    expect(decisions.memberPrivateWrite.allowed).toBe(false)
  })

  test("bootstraps the first writer of an empty hosted workspace as owner", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const owner = yield* WorkspaceAccess.ensureWorkspaceForCreate({
          workspace_id: otherWorkspaceId,
          user_id: ownerId,
          action: "write",
        })
        const memberships = yield* WorkspaceStore.listMemberships(otherWorkspaceId)
        return { owner, memberships }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.owner.allowed).toBe(true)
    expect(result.memberships).toEqual([membership(ownerId, "owner", otherWorkspaceId)])
  })

  test("denies later create access to outsiders after a workspace has members", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* WorkspaceAccess.ensureWorkspaceForCreate({
          workspace_id: otherWorkspaceId,
          user_id: ownerId,
          action: "write",
        })
        const outsider = yield* WorkspaceAccess.authorizeWorkspace({
          workspace_id: otherWorkspaceId,
          user_id: outsiderId,
          action: "write",
        })
        const outsiderCreate = yield* WorkspaceAccess.ensureWorkspaceForCreate({
          workspace_id: otherWorkspaceId,
          user_id: outsiderId,
          action: "write",
        }).pipe(Effect.flip)
        const memberships = yield* WorkspaceStore.listMemberships(otherWorkspaceId)
        return { outsider, outsiderCreate, memberships }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.outsider.allowed).toBe(false)
    expect(result.outsiderCreate).toBeInstanceOf(WorkspaceAccess.WorkspaceAccessDenied)
    expect(result.outsiderCreate).toMatchObject({
      action: "write",
      workspace_id: otherWorkspaceId,
      user_id: outsiderId,
    })
    expect(result.memberships).toEqual([membership(ownerId, "owner", otherWorkspaceId)])
  })
})

const membership = (
  userId: Ids.UserId,
  role: Workspace.MembershipRole,
  workspaceIdValue: Ids.WorkspaceId,
): Workspace.Membership => ({
  workspace_id: workspaceIdValue,
  user_id: userId,
  role,
  created_at: now,
})

const threadCreated = (): Event.ThreadCreated => ({
  id: Ids.EventId.make("event_access_thread_created"),
  thread_id: threadId,
  sequence: 1,
  version: 1,
  created_at: now,
  type: "thread.created",
  data: { workspace_id: workspaceId },
})

const threadVisibilitySetForThread = (): Event.Event =>
  ({
    id: Ids.EventId.make("event_access_thread_visibility"),
    thread_id: threadId,
    sequence: 2,
    version: 1,
    created_at: now,
    type: "thread.visibility.set",
    data: { visibility: "workspace" },
  }) as Event.Event

const appendProjected = (event: Event.Event) =>
  Effect.gen(function* () {
    const appended = yield* ThreadEventLog.append(event)
    yield* ThreadProjection.apply(appended)
    return appended
  })

const visibilityThreadId = (visibility: "private" | "workspace" | "unlisted") =>
  Ids.ThreadId.make(`thread_access_${visibility}`)

const threadCreatedFor = (visibility: "private" | "workspace" | "unlisted"): Event.ThreadCreated => ({
  id: Ids.EventId.make(`event_access_${visibility}_created`),
  thread_id: visibilityThreadId(visibility),
  sequence: 1,
  version: 1,
  created_at: now,
  type: "thread.created",
  data: { workspace_id: workspaceId, user_id: ownerId },
})

const threadVisibilitySet = (visibility: "workspace" | "unlisted"): Event.Event =>
  ({
    id: Ids.EventId.make(`event_access_${visibility}_visibility`),
    thread_id: visibilityThreadId(visibility),
    sequence: 2,
    version: 1,
    created_at: now,
    type: "thread.visibility.set",
    data: { visibility },
  }) as Event.Event
