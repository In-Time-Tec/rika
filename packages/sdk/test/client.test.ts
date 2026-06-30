import { describe, expect, test } from "bun:test"
import { Codec, Common, Event, Ide, Ids, Remote } from "@rika/schema"
import { Effect, Schema, Stream } from "effect"
import { Client } from "../src/index"

const threadId = Ids.ThreadId.make("thread_sdk_client")
const workspaceId = Ids.WorkspaceId.make("workspace_sdk_client")
const turnId = Ids.TurnId.make("turn_sdk_client")
const eventId = Ids.EventId.make("event_sdk_client")
const ideClientId = Ids.IdeClientId.make("ide_sdk_client")
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
        return Effect.succeed(Codec.encode(Remote.ThreadSummary)(summary))
      },
      streamJson: (input) => {
        calls.push(input)
        return Stream.make(Codec.encode(Event.Event)(started))
      },
    })

    const created = await Effect.runPromise(client.createThread({ thread_id: threadId, workspace_id: workspaceId }))
    const events = await Effect.runPromise(
      client.startTurn({ thread_id: threadId, content: "ship", workspace_id: workspaceId }).pipe(Stream.runCollect),
    )

    expect(created).toEqual(summary)
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
    ])
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

  test("turn streams preserve server API errors as SDK errors", async () => {
    const client = Client.make({
      requestJson: () => Effect.die("unused"),
      streamJson: () =>
        Stream.make(
          Codec.encode(Remote.StreamFrame)({
            error: { message: "Workspace denied", code: "workspace_denied", details: { status: 403 } },
          }),
        ),
    })

    const error = await Effect.runPromise(
      client
        .startTurn({ thread_id: threadId, workspace_id: workspaceId, content: "ship" })
        .pipe(Stream.runCollect, Effect.flip),
    )

    expect(error).toMatchObject({ message: "Workspace denied", operation: "startTurn", status: 403 })
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
