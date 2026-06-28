import { describe, expect, test } from "bun:test"
import { Codec, Common, Event, Ids, Remote } from "@rika/schema"
import { Effect, Stream } from "effect"
import { Client } from "../src/index"

const threadId = Ids.ThreadId.make("thread_sdk_client")
const workspaceId = Ids.WorkspaceId.make("workspace_sdk_client")
const turnId = Ids.TurnId.make("turn_sdk_client")
const eventId = Ids.EventId.make("event_sdk_client")
const now = Common.TimestampMillis.make(2_000_000_000_001)

describe("SDK client", () => {
  test("uses shared schemas for requests, responses, and event streams", async () => {
    const calls: Array<Client.RequestInput> = []
    const summary: Remote.ThreadSummary = {
      thread_id: threadId,
      workspace_id: workspaceId,
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
})
