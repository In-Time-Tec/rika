import { describe, expect, test } from "bun:test"
import { Artifact, Codec, Common, Event, Ide, Ids, Remote } from "@rika/schema"
import { Deferred, Effect, Fiber, Schema, Stream } from "effect"
import { Client } from "../src/index"

const threadId = Ids.ThreadId.make("thread_sdk_client")
const workspaceId = Ids.WorkspaceId.make("workspace_sdk_client")
const projectId = Ids.ProjectId.make("project_sdk_client")
const orbId = Ids.OrbId.make("orb_sdk_client")
const turnId = Ids.TurnId.make("turn_sdk_client")
const eventId = Ids.EventId.make("event_sdk_client")
const ideClientId = Ids.IdeClientId.make("ide_sdk_client")
const userId = Ids.UserId.make("user_sdk_client")
const now = Common.TimestampMillis.make(2_000_000_000_001)

describe("SDK client", () => {
  test("uses shared schemas for requests, responses, and event streams", async () => {
    const calls: Array<Client.RequestInput> = []
    const summary: Remote.ThreadSummary = {
      thread_id: threadId,
      workspace_id: workspaceId,
      title_text: "ship",
      diff: { additions: 0, modifications: 0, deletions: 0 },
      archived: false,
      visibility: "private",
      created_at: now,
      updated_at: now,
    }
    const started: Event.TurnStarted = {
      id: eventId,
      thread_id: threadId,
      turn_id: turnId,
      sequence: 1,
      version: 1,
      created_at: now,
      type: "turn.started",
      data: {},
    }

    const client = Client.make({
      requestJson: (input) => {
        calls.push(input)
        if (input.path === "/v1/turns") {
          return Effect.succeed(Codec.encode(Remote.StartTurnResponse)({ thread_id: threadId, accepted: true }))
        }
        return Effect.succeed(Codec.encode(Remote.ThreadSummary)(summary))
      },
      streamJson: (input) => {
        calls.push(input)
        return Stream.make(Codec.encode(Event.Event)(started))
      },
    })

    const created = await Effect.runPromise(client.createThread({ thread_id: threadId, workspace_id: workspaceId }))
    const accepted = await Effect.runPromise(
      client.startTurn({ thread_id: threadId, content: "ship", workspace_id: workspaceId }),
    )
    const events = await Effect.runPromise(
      client.subscribeThreadEvents({ thread_id: threadId }).pipe(Stream.runCollect),
    )

    expect(created).toEqual(summary)
    expect(accepted).toEqual({ thread_id: threadId, accepted: true })
    expect(events).toEqual([started])
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/v1/threads",
        body: { thread_id: threadId, workspace_id: workspaceId },
      },
      {
        method: "POST",
        path: "/v1/turns",
        body: { thread_id: threadId, workspace_id: workspaceId, content: "ship" },
      },
      {
        method: "GET",
        path: "/v1/threads/thread_sdk_client/events",
      },
    ])
  })

  test("applies transport user_id defaults to requests that carry user identity", async () => {
    const calls: Array<Client.RequestInput> = []
    const summary: Remote.ThreadSummary = {
      thread_id: threadId,
      workspace_id: workspaceId,
      diff: { additions: 0, modifications: 0, deletions: 0 },
      archived: false,
      visibility: "private",
      created_at: now,
      updated_at: now,
    }
    const client = Client.make({
      user_id: userId,
      requestJson: (input) => {
        calls.push(input)
        if (input.path === "/v1/threads") return Effect.succeed(Codec.encode(Remote.ThreadSummary)(summary))
        if (input.path === "/v1/threads?user_id=user_sdk_client") {
          return Effect.succeed(Codec.encode(Schema.Array(Remote.ThreadSummary))([summary]))
        }
        if (input.path === "/v1/threads/thread_sdk_client?user_id=user_sdk_client") {
          return Effect.succeed(Codec.encode(Remote.ThreadRecord)({ summary, events: [] }))
        }
        if (input.path === "/v1/threads/thread_sdk_client/visibility?user_id=user_sdk_client") {
          return Effect.succeed(Codec.encode(Remote.ThreadSummary)({ ...summary, visibility: "workspace" }))
        }
        if (input.path === "/v1/turns") {
          return Effect.succeed(Codec.encode(Remote.StartTurnResponse)({ thread_id: threadId, accepted: true }))
        }
        if (input.path === "/v1/artifacts?thread_id=thread_sdk_client&user_id=user_sdk_client") {
          return Effect.succeed(Codec.encode(Schema.Array(Artifact.Artifact))([]))
        }
        return Effect.fail(new Client.SdkError({ message: `unexpected ${input.path}`, operation: "requestJson" }))
      },
      streamJson: () => Stream.empty,
    })

    await Effect.runPromise(client.createThread({ thread_id: threadId, workspace_id: workspaceId }))
    await Effect.runPromise(client.listThreads())
    await Effect.runPromise(client.openThread(threadId))
    await Effect.runPromise(client.setThreadVisibility(threadId, "workspace"))
    await Effect.runPromise(client.startTurn({ thread_id: threadId, workspace_id: workspaceId, content: "ship" }))
    await Effect.runPromise(client.listArtifacts({ thread_id: threadId }))

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/v1/threads",
        body: { thread_id: threadId, workspace_id: workspaceId, user_id: userId },
      },
      { method: "GET", path: "/v1/threads?user_id=user_sdk_client" },
      { method: "GET", path: "/v1/threads/thread_sdk_client?user_id=user_sdk_client" },
      {
        method: "POST",
        path: "/v1/threads/thread_sdk_client/visibility?user_id=user_sdk_client",
        body: { visibility: "workspace" },
      },
      {
        method: "POST",
        path: "/v1/turns",
        body: { thread_id: threadId, workspace_id: workspaceId, user_id: userId, content: "ship" },
      },
      { method: "GET", path: "/v1/artifacts?thread_id=thread_sdk_client&user_id=user_sdk_client" },
    ])
  })

  test("routes presence frames to callbacks while event subscribers remain event-only", async () => {
    const calls: Array<Client.RequestInput> = []
    const snapshots: Array<Remote.PresenceFrame["presence"]> = []
    const started: Event.TurnStarted = {
      id: eventId,
      thread_id: threadId,
      turn_id: turnId,
      sequence: 1,
      version: 1,
      created_at: now,
      type: "turn.started",
      data: { user_id: userId },
    }
    const presence: Remote.PresenceFrame = {
      presence: {
        thread_id: threadId,
        users: [{ user_id: userId, state: "active", last_seen: now }],
      },
    }
    const client = Client.make({
      user_id: userId,
      requestJson: (input) => {
        calls.push(input)
        return Effect.succeed(Codec.encode(Remote.PresenceFrame)(presence))
      },
      streamJson: (input) => {
        calls.push(input)
        return Stream.fromIterable([Codec.encode(Remote.StreamFrame)(presence), Codec.encode(Event.Event)(started)])
      },
    })

    const events = await Effect.runPromise(
      client
        .subscribeThreadEvents({
          thread_id: threadId,
          onPresence: (snapshot) => snapshots.push(snapshot),
        })
        .pipe(Stream.take(1), Stream.runCollect),
    )

    expect(events).toEqual([started])
    expect(snapshots).toEqual([presence.presence])
    expect(calls).toContainEqual({
      method: "GET",
      path: "/v1/threads/thread_sdk_client/events?user_id=user_sdk_client",
    })
    expect(calls).toContainEqual({
      method: "POST",
      path: "/v1/threads/thread_sdk_client/presence",
      body: { user_id: userId, state: "active" },
    })
  })

  test("keeps the event stream alive when a presence heartbeat fails", async () => {
    const heartbeatAttempted = Effect.runSync(Deferred.make<void>())
    const releaseEvent = Effect.runSync(Deferred.make<void>())
    const started: Event.TurnStarted = {
      id: eventId,
      thread_id: threadId,
      turn_id: turnId,
      sequence: 1,
      version: 1,
      created_at: now,
      type: "turn.started",
      data: { user_id: userId },
    }
    const client = Client.make({
      user_id: userId,
      requestJson: () =>
        Deferred.succeed(heartbeatAttempted, undefined).pipe(
          Effect.andThen(
            Effect.fail(new Client.SdkError({ message: "heartbeat failed", operation: "setThreadPresence" })),
          ),
        ),
      streamJson: () =>
        Stream.fromEffect(Deferred.await(releaseEvent).pipe(Effect.as(Codec.encode(Event.Event)(started)))),
    })

    const fiber = Effect.runFork(
      client.subscribeThreadEvents({ thread_id: threadId }).pipe(Stream.take(1), Stream.runCollect),
    )

    await Effect.runPromise(Deferred.await(heartbeatAttempted).pipe(Effect.timeout("1 second")))
    await Effect.runPromise(Deferred.succeed(releaseEvent, undefined))
    const events = await Effect.runPromise(Fiber.join(fiber).pipe(Effect.timeout("1 second")))

    expect(events).toEqual([started])
  })

  test("uses shared schemas for thread preview requests", async () => {
    const calls: Array<Client.RequestInput> = []
    const summary: Remote.ThreadSummary = {
      thread_id: threadId,
      workspace_id: workspaceId,
      title_text: "Preview me",
      latest_message_text: "Preview me",
      diff: { additions: 3, modifications: 1, deletions: 1 },
      archived: false,
      visibility: "private",
      created_at: now,
      updated_at: now,
    }
    const record: Remote.ThreadRecord = { summary, events: [] }
    const client = Client.make({
      requestJson: (input) => {
        calls.push(input)
        return Effect.succeed(Codec.encode(Remote.ThreadRecord)(record))
      },
      streamJson: () => Stream.empty,
    })

    const preview = await Effect.runPromise(client.previewThread(threadId, { limit: 80 }))

    expect(preview).toEqual(record)
    expect(calls).toEqual([{ method: "GET", path: "/v1/threads/thread_sdk_client/preview?limit=80" }])
  })

  test("uses shared schemas for project and orb-thread requests", async () => {
    const calls: Array<Client.RequestInput> = []
    const project = {
      project_id: projectId,
      name: "demo",
      repo_origin: "https://github.com/example/rika.git",
      default_branch: "main",
      template_id: null,
      env: { NODE_ENV: "development" },
      secret_names: [],
      created_at: now,
      updated_at: now,
    }
    const projectSummary = {
      ...project,
      env_keys: ["NODE_ENV"],
      env: undefined,
    }
    const summary: Remote.ThreadSummary = {
      thread_id: threadId,
      workspace_id: Ids.WorkspaceId.make("project:project_sdk_client"),
      diff: { additions: 0, modifications: 0, deletions: 0 },
      orb_status: "running",
      archived: false,
      visibility: "private",
      created_at: now,
      updated_at: now,
    }
    const client = Client.make({
      requestJson: (input) => {
        calls.push(input)
        if (input.method === "GET" && input.path === "/v1/projects") {
          const { env: _env, ...projectSummaryPayload } = projectSummary
          return Effect.succeed(Codec.encode(Schema.Array(Remote.ProjectSummary))([projectSummaryPayload]))
        }
        if (input.method === "POST" && input.path === "/v1/projects") {
          return Effect.succeed(project)
        }
        if (input.method === "GET" && input.path === `/v1/projects/${projectId}`) {
          return Effect.succeed(project)
        }
        if (input.method === "PATCH" && input.path === `/v1/projects/${projectId}`) {
          return Effect.succeed({ ...project, name: "renamed", env: { NODE_ENV: "test" } })
        }
        if (input.method === "PUT" && input.path === `/v1/projects/${projectId}/secrets/OPENAI_API_KEY`) {
          return Effect.succeed({ ...project, secret_names: ["OPENAI_API_KEY"] })
        }
        if (input.method === "DELETE" && input.path === `/v1/projects/${projectId}/secrets/OPENAI_API_KEY`) {
          return Effect.succeed({ ...project, secret_names: [] })
        }
        if (input.method === "POST" && input.path === "/v1/orbs") {
          return Effect.succeed(Codec.encode(Remote.ThreadSummary)(summary))
        }
        return Effect.fail(new Client.SdkError({ message: `unexpected ${input.path}`, operation: "requestJson" }))
      },
      streamJson: () => Stream.empty,
    })

    const projects = await Effect.runPromise(client.listProjects())
    const createdProject = await Effect.runPromise(
      client.createProject({
        name: "demo",
        repo_origin: "https://github.com/example/rika.git",
        env: { NODE_ENV: "development" },
      }),
    )
    const projectDetail = await Effect.runPromise(client.getProject(projectId))
    const updatedProject = await Effect.runPromise(
      client.updateProject(projectId, { name: "renamed", env: { NODE_ENV: "test" } }),
    )
    const withSecret = await Effect.runPromise(
      client.setProjectSecret(projectId, "OPENAI_API_KEY", { value: "secret-value" }),
    )
    const withoutSecret = await Effect.runPromise(client.deleteProjectSecret(projectId, "OPENAI_API_KEY"))
    const createdOrb = await Effect.runPromise(
      client.createOrbThread({ project_id: projectId, thread_id: threadId, mode: "smart" }),
    )

    const { env: _env, ...expectedSummary } = projectSummary
    expect(projects).toEqual([expectedSummary])
    expect(createdProject).toEqual(project)
    expect(projectDetail).toEqual(project)
    expect(updatedProject).toEqual({ ...project, name: "renamed", env: { NODE_ENV: "test" } })
    expect(withSecret.secret_names).toEqual(["OPENAI_API_KEY"])
    expect(JSON.stringify(withSecret)).not.toContain("secret-value")
    expect(withoutSecret.secret_names).toEqual([])
    expect(createdOrb).toEqual(summary)
    expect(calls).toEqual([
      { method: "GET", path: "/v1/projects" },
      {
        method: "POST",
        path: "/v1/projects",
        body: {
          name: "demo",
          repo_origin: "https://github.com/example/rika.git",
          env: { NODE_ENV: "development" },
        },
      },
      { method: "GET", path: `/v1/projects/${projectId}` },
      {
        method: "PATCH",
        path: `/v1/projects/${projectId}`,
        body: { name: "renamed", env: { NODE_ENV: "test" } },
      },
      {
        method: "PUT",
        path: `/v1/projects/${projectId}/secrets/OPENAI_API_KEY`,
        body: { value: "secret-value" },
      },
      { method: "DELETE", path: `/v1/projects/${projectId}/secrets/OPENAI_API_KEY` },
      {
        method: "POST",
        path: "/v1/orbs",
        body: { project_id: projectId, thread_id: threadId, mode: "smart" },
      },
    ])
  })

  test("uses shared schema for orb changes requests", async () => {
    const calls: Array<Client.RequestInput> = []
    const changes: Remote.OrbChangesResponse = {
      base_commit: "abc123",
      head_commit: "def456",
      diff: "diff --git a/README.md b/README.md\n",
      dirty: true,
    }
    const client = Client.make({
      requestJson: (input) => {
        calls.push(input)
        return Effect.succeed(Codec.encode(Remote.OrbChangesResponse)(changes))
      },
      streamJson: () => Stream.empty,
    })

    const result = await Effect.runPromise(client.orbChanges())

    expect(result).toEqual(changes)
    expect(calls).toEqual([{ method: "GET", path: "/v1/orb/changes" }])
  })

  test("uses shared schemas for orb file requests", async () => {
    const calls: Array<Client.RequestInput> = []
    const files: Remote.OrbFilesResponse = {
      path: "src",
      entries: [{ name: "index.ts", path: "src/index.ts", kind: "file", size: 23 }],
    }
    const file: Remote.OrbFileResponse = {
      path: "src/index.ts",
      kind: "text",
      content: "export const value = 1\n",
      truncated: false,
    }
    const client = Client.make({
      requestJson: (input) => {
        calls.push(input)
        if (input.path === "/v1/orb/files?path=src") return Effect.succeed(Codec.encode(Remote.OrbFilesResponse)(files))
        if (input.path === "/v1/orb/file?path=src%2Findex.ts") {
          return Effect.succeed(Codec.encode(Remote.OrbFileResponse)(file))
        }
        return Effect.fail(new Client.SdkError({ message: `unexpected ${input.path}`, operation: "requestJson" }))
      },
      streamJson: () => Stream.empty,
    })

    const listed = await Effect.runPromise(client.orbFiles("src"))
    const opened = await Effect.runPromise(client.orbFile("src/index.ts"))

    expect(listed).toEqual(files)
    expect(opened).toEqual(file)
    expect(calls).toEqual([
      { method: "GET", path: "/v1/orb/files?path=src" },
      { method: "GET", path: "/v1/orb/file?path=src%2Findex.ts" },
    ])
  })

  test("uses shared schemas for orb lifecycle endpoints without endpoint credentials", async () => {
    const calls: Array<Client.RequestInput> = []
    const summary: Remote.OrbSummary = {
      orb_id: orbId,
      thread_id: threadId,
      project_id: projectId,
      status: "running",
      base_commit: "abc123",
      created_at: now,
      last_active_at: now,
      running_minutes: 7,
    }
    const paused: Remote.OrbSummary = { ...summary, status: "paused" }
    const killed: Remote.OrbSummary = { ...summary, status: "killed" }
    const client = Client.make({
      requestJson: (input) => {
        calls.push(input)
        if (input.method === "GET" && input.path === "/v1/orbs") {
          return Effect.succeed(Codec.encode(Schema.Array(Remote.OrbSummary))([summary]))
        }
        if (input.method === "GET" && input.path === "/v1/orbs/by-thread/thread_sdk_client") {
          return Effect.succeed(Codec.encode(Remote.OrbSummary)(summary))
        }
        if (input.method === "POST" && input.path === "/v1/orbs/orb_sdk_client/pause") {
          return Effect.succeed(Codec.encode(Remote.OrbSummary)(paused))
        }
        if (input.method === "POST" && input.path === "/v1/orbs/orb_sdk_client/resume") {
          return Effect.succeed(Codec.encode(Remote.OrbSummary)(summary))
        }
        if (input.method === "POST" && input.path === "/v1/orbs/orb_sdk_client/kill") {
          return Effect.succeed(Codec.encode(Remote.OrbSummary)(killed))
        }
        return Effect.fail(new Client.SdkError({ message: `unexpected ${input.path}`, operation: "requestJson" }))
      },
      streamJson: () => Stream.empty,
    })

    const listed = await Effect.runPromise(client.listOrbs())
    const byThread = await Effect.runPromise(client.getOrbByThread(threadId))
    const pause = await Effect.runPromise(client.pauseOrb(orbId))
    const resume = await Effect.runPromise(client.resumeOrb(orbId))
    const kill = await Effect.runPromise(client.killOrb(orbId))

    expect(listed).toEqual([summary])
    expect(byThread).toEqual(summary)
    expect(pause).toEqual(paused)
    expect(resume).toEqual(summary)
    expect(kill).toEqual(killed)
    expect(JSON.stringify(listed)).not.toContain("orb-token")
    expect(JSON.stringify(listed)).not.toContain("orb.remote")
    expect(calls).toEqual([
      { method: "GET", path: "/v1/orbs" },
      { method: "GET", path: "/v1/orbs/by-thread/thread_sdk_client" },
      { method: "POST", path: "/v1/orbs/orb_sdk_client/pause" },
      { method: "POST", path: "/v1/orbs/orb_sdk_client/resume" },
      { method: "POST", path: "/v1/orbs/orb_sdk_client/kill" },
    ])
  })

  test("uses shared schema for manual thread compaction", async () => {
    const calls: Array<Client.RequestInput> = []
    const event: Event.ContextCompacted = {
      id: Ids.EventId.make("event_sdk_context_compacted"),
      thread_id: threadId,
      sequence: 2,
      version: 1,
      created_at: now,
      type: "context.compacted",
      data: {
        summary: "Goal\n- compacted",
        tail_start_sequence: 1,
        trigger: "manual",
        tokens_before: 100,
        model: "gpt-5.5",
      },
    }
    const client = Client.make({
      requestJson: (input) => {
        calls.push(input)
        return Effect.succeed(Codec.encode(Event.ContextCompacted)(event))
      },
      streamJson: () => Stream.empty,
    })

    const compacted = await Effect.runPromise(client.compactThread(threadId, userId))

    expect(compacted).toEqual(event)
    expect(calls).toEqual([{ method: "POST", path: "/v1/threads/thread_sdk_client/compact?user_id=user_sdk_client" }])
  })

  test("uses shared schema for thread fork requests", async () => {
    const calls: Array<Client.RequestInput> = []
    const summary: Remote.ThreadSummary = {
      thread_id: Ids.ThreadId.make("thread_sdk_fork"),
      workspace_id: workspaceId,
      title_text: "forked",
      diff: { additions: 0, modifications: 0, deletions: 0 },
      archived: false,
      visibility: "private",
      created_at: now,
      updated_at: now,
    }
    const client = Client.make({
      requestJson: (input) => {
        calls.push(input)
        return Effect.succeed(Codec.encode(Remote.ThreadSummary)(summary))
      },
      streamJson: () => Stream.empty,
    })

    const forked = await Effect.runPromise(
      client.forkThread(threadId, { at_turn: turnId, user_id: userId, title_text: "tournament:sdk/1" }),
    )

    expect(forked).toEqual(summary)
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/v1/threads/thread_sdk_client/fork",
        body: { thread_id: threadId, at_turn: turnId, user_id: userId, title_text: "tournament:sdk/1" },
      },
    ])
  })

  test("fetch transport sends bearer auth and decodes API errors", async () => {
    let authorization: string | undefined
    const client = Client.make(
      Client.fetchTransport({
        base_url: "http://rika.test/",
        token: "secret",
        fetch: async (_input, init) => {
          authorization = new Headers(init?.headers).get("authorization") ?? undefined
          return new Response(JSON.stringify({ error: { message: "Unauthorized", code: "unauthorized" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          })
        },
      }),
    )

    const error = await Effect.runPromise(client.listThreads().pipe(Effect.flip))

    expect(authorization).toBe("Bearer secret")
    expect(error).toMatchObject({ message: "Unauthorized", operation: "requestJson", status: 401 })
  })

  test("fetch transport aborts requestJson when the fiber is interrupted", async () => {
    const started = Effect.runSync(Deferred.make<void>())
    let signal: AbortSignal | undefined
    let aborted = false
    const client = Client.make(
      Client.fetchTransport({
        base_url: "http://rika.test",
        fetch: (_input, init) => {
          signal = init?.signal ?? undefined
          signal?.addEventListener("abort", () => {
            aborted = true
          })
          Effect.runSync(Deferred.succeed(started, undefined))
          return new Promise<Response>(() => {})
        },
      }),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* client.listThreads().pipe(Effect.forkScoped({ startImmediately: true }))
          yield* Deferred.await(started).pipe(Effect.timeout("1 second"))
          yield* Fiber.interrupt(fiber)
        }),
      ),
    )

    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(true)
    expect(aborted).toBe(true)
  })

  test("fetch transport preserves HTTP status when an error body is not JSON", async () => {
    const client = Client.make(
      Client.fetchTransport({
        base_url: "http://rika.test",
        fetch: async () => new Response("<html>proxy conflict</html>", { status: 409 }),
      }),
    )

    const error = await Effect.runPromise(client.listThreads().pipe(Effect.flip))

    expect(error).toMatchObject({
      message: "Rika API request failed with status 409",
      operation: "requestJson",
      status: 409,
    })
  })

  test("turn submission preserves server API errors as SDK errors", async () => {
    const client = Client.make({
      requestJson: () =>
        Effect.succeed({
          error: { message: "Workspace denied", code: "workspace_denied", details: { status: 403 } },
        }),
      streamJson: () => Stream.empty,
    })

    const error = await Effect.runPromise(
      client.startTurn({ thread_id: threadId, workspace_id: workspaceId, content: "ship" }).pipe(Effect.flip),
    )

    expect(error).toMatchObject({ message: "Workspace denied", operation: "startTurn", status: 403 })
  })

  test("turn submission preserves the active user on conflict API errors", async () => {
    const activeUserId = Ids.UserId.make("user_sdk_active_turn")
    const client = Client.make({
      requestJson: () =>
        Effect.succeed({
          error: {
            message: "Another user is running this thread",
            code: "turn_conflict",
            details: { status: 409, active_user_id: activeUserId },
          },
        }),
      streamJson: () => Stream.empty,
    })

    const error = await Effect.runPromise(
      client.startTurn({ thread_id: threadId, workspace_id: workspaceId, content: "ship" }).pipe(Effect.flip),
    )

    expect(error).toMatchObject({
      message: "Another user is running this thread",
      operation: "startTurn",
      status: 409,
      active_user_id: activeUserId,
    })
  })

  test("uses shared schemas for IDE endpoints", async () => {
    const calls: Array<Client.RequestInput> = []
    const context: Ide.ContextSnapshot = {
      workspace_roots: ["/workspace/rika"],
      active_file: { path: "src/index.ts", selection: { range: { start_line: 1, end_line: 3 } } },
    }
    const navigationRequest: Ide.OpenFileRequest = {
      path: "src/index.ts",
      range: { start_line: 1, end_line: 3 },
      reason: "Show file",
    }
    const client = Client.make({
      requestJson: (input) => {
        calls.push(input)
        switch (input.path) {
          case "/v1/ide/connect":
            return Effect.succeed(
              Codec.encode(Ide.ConnectResponse)({
                client_id: ideClientId,
                connected: true,
                capabilities: ["active-context", "navigation"],
              }),
            )
          case "/v1/ide/status":
            return Effect.succeed(
              Codec.encode(Ide.Status)({
                connected: true,
                client_id: ideClientId,
                capabilities: ["active-context", "navigation"],
                workspace_roots: ["/workspace/rika"],
                context,
              }),
            )
          case "/v1/ide/open-file":
            return Effect.succeed(Codec.encode(Ide.OpenFileResult)({ accepted: true }))
          case "/v1/ide/navigation-requests":
            return Effect.succeed(Codec.encode(Schema.Array(Ide.OpenFileRequest))([navigationRequest]))
        }
        return Effect.die(`unexpected request ${input.path}`)
      },
      streamJson: () => Stream.empty,
    })

    const connected = await Effect.runPromise(
      client.connectIde({
        client_id: ideClientId,
        workspace_roots: ["/workspace/rika"],
        capabilities: ["active-context", "navigation"],
        initial_context: context,
      }),
    )
    const status = await Effect.runPromise(client.ideStatus())
    const opened = await Effect.runPromise(client.openIdeFile(navigationRequest))
    const requests = await Effect.runPromise(client.ideNavigationRequests())

    expect(connected).toEqual({
      client_id: ideClientId,
      connected: true,
      capabilities: ["active-context", "navigation"],
    })
    expect(status).toMatchObject({ connected: true, client_id: ideClientId, context })
    expect(opened).toEqual({ accepted: true })
    expect(requests).toEqual([navigationRequest])
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/v1/ide/connect",
        body: {
          client_id: ideClientId,
          workspace_roots: ["/workspace/rika"],
          capabilities: ["active-context", "navigation"],
          initial_context: context,
        },
      },
      { method: "GET", path: "/v1/ide/status" },
      { method: "POST", path: "/v1/ide/open-file", body: navigationRequest },
      { method: "GET", path: "/v1/ide/navigation-requests" },
    ])
  })
})
