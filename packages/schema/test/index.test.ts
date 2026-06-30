import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Artifact, Codec, ErrorEnvelope, Event, Ide, Ids, Message, Remote, Tool, Workspace } from "../src/index"

const now = 1_765_000_000_000
const threadId = Ids.ThreadId.make("thread_1")
const turnId = Ids.TurnId.make("turn_1")
const messageId = Ids.MessageId.make("message_1")
const eventId = Ids.EventId.make("event_1")
const toolCallId = Ids.ToolCallId.make("tool_1")
const artifactId = Ids.ArtifactId.make("artifact_1")
const workspaceId = Ids.WorkspaceId.make("workspace_1")

describe("Rika protocol schemas", () => {
  test("round-trips messages", () => {
    const message = Message.user({
      id: messageId,
      thread_id: threadId,
      turn_id: turnId,
      content: "Build Rika",
      created_at: now,
    })

    const encoded = Schema.encodeSync(Message.Message)(message)
    const decoded = Schema.decodeUnknownSync(Message.Message)(encoded)

    expect(decoded).toEqual(message)
  })

  test("round-trips image message parts with display text", () => {
    const message = Message.user({
      id: messageId,
      thread_id: threadId,
      turn_id: turnId,
      content: [
        Message.text("Look at "),
        Message.image({
          media_type: "image/png",
          data: "cG5n",
          filename: ".rika/pasted/test.png",
          metadata: { label: "[Image 1]" },
        }),
        Message.text(" please"),
      ],
      created_at: now,
    })

    const decoded = Schema.decodeUnknownSync(Message.Message)(Schema.encodeSync(Message.Message)(message))

    expect(decoded).toEqual(message)
    expect(Message.displayText(decoded)).toBe("Look at [Image 1] please")
  })

  test("round-trips tool calls and results", () => {
    const call: Tool.Call = {
      id: toolCallId,
      name: "read",
      input: { path: "README.md" },
    }
    const result: Tool.Result = {
      id: toolCallId,
      name: "read",
      status: "success",
      output: { lines: 3 },
    }

    expect(Codec.decode(Tool.Call)(Schema.encodeSync(Tool.Call)(call))).toEqual(call)
    expect(Codec.decode(Tool.Result)(Schema.encodeSync(Tool.Result)(result))).toEqual(result)
  })

  test("round-trips typed events", () => {
    const event: Event.Event = {
      id: eventId,
      thread_id: threadId,
      turn_id: turnId,
      sequence: 1,
      version: 1,
      created_at: now,
      type: "message.added",
      data: {
        message: Message.user({
          id: messageId,
          thread_id: threadId,
          turn_id: turnId,
          content: [Message.text("Hello")],
          created_at: now,
        }),
      },
    }

    const encoded = Codec.encode(Event.Event)(event)
    const decoded = Codec.decode(Event.Event)(encoded)

    expect(decoded).toEqual(event)
    expect(Event.references(decoded)).toEqual({ message_id: messageId })
  })

  test("round-trips artifacts and error envelopes", () => {
    const artifact: Artifact.Artifact = {
      id: artifactId,
      thread_id: threadId,
      turn_id: turnId,
      kind: "research",
      title: "Amp surface",
      content: { source: "manual" },
      created_at: now,
    }
    const error: ErrorEnvelope.Envelope = {
      kind: "tool",
      message: "Tool failed",
      retryable: true,
      details: { tool: "read" },
    }

    expect(Codec.decode(Artifact.Artifact)(Codec.encode(Artifact.Artifact)(artifact))).toEqual(artifact)
    expect(Codec.decode(ErrorEnvelope.Envelope)(Codec.encode(ErrorEnvelope.Envelope)(error))).toEqual(error)
  })

  test("round-trips thread-created event", () => {
    const event: Event.Event = {
      id: eventId,
      thread_id: threadId,
      sequence: 1,
      version: 1,
      created_at: now,
      type: "thread.created",
      data: { workspace_id: workspaceId },
    }

    expect(Codec.decode(Event.Event)(Codec.encode(Event.Event)(event))).toEqual(event)
  })

  test("round-trips thread archive lifecycle events", () => {
    const archived: Event.Event = {
      id: Ids.EventId.make("event_archived"),
      thread_id: threadId,
      sequence: 2,
      version: 1,
      created_at: now,
      type: "thread.archived",
      data: {},
    }
    const unarchived: Event.Event = {
      id: Ids.EventId.make("event_unarchived"),
      thread_id: threadId,
      sequence: 3,
      version: 1,
      created_at: now,
      type: "thread.unarchived",
      data: {},
    }

    expect(Codec.decode(Event.Event)(Codec.encode(Event.Event)(archived))).toEqual(archived)
    expect(Codec.decode(Event.Event)(Codec.encode(Event.Event)(unarchived))).toEqual(unarchived)
  })

  test("round-trips model stream chunk events", () => {
    const event: Event.Event = {
      id: eventId,
      thread_id: threadId,
      turn_id: turnId,
      sequence: 2,
      version: 1,
      created_at: now,
      type: "model.stream.chunk",
      data: { text: "delta", provider: "openai", model: "gpt-5.5" },
    }

    expect(Codec.decode(Event.Event)(Codec.encode(Event.Event)(event))).toEqual(event)
  })

  test("round-trips resolved context events", () => {
    const event: Event.Event = {
      id: eventId,
      thread_id: threadId,
      turn_id: turnId,
      sequence: 3,
      version: 1,
      created_at: now,
      type: "context.resolved",
      data: {
        entries: [
          {
            kind: "guidance",
            source: "agents-md",
            reason: "workspace guidance",
            trusted: false,
            path: "AGENTS.md",
            content: "Use tests",
          },
        ],
        rendered: "<rika_context>Use tests</rika_context>",
        total_chars: 38,
      },
    }

    expect(Codec.decode(Event.Event)(Codec.encode(Event.Event)(event))).toEqual(event)
  })

  test("round-trips skill loaded events", () => {
    const event: Event.Event = {
      id: eventId,
      thread_id: threadId,
      turn_id: turnId,
      sequence: 4,
      version: 1,
      created_at: now,
      type: "skill.loaded",
      data: {
        name: "deploy",
        description: "Deploy safely",
        source: "project",
        skill_file: ".agents/skills/deploy/SKILL.md",
        resource_paths: ["scripts/deploy.ts"],
      },
    }

    expect(Codec.decode(Event.Event)(Codec.encode(Event.Event)(event))).toEqual(event)
  })

  test("round-trips subagent summary events", () => {
    const event: Event.Event = {
      id: eventId,
      thread_id: threadId,
      turn_id: turnId,
      sequence: 5,
      version: 1,
      created_at: now,
      type: "subagent.completed",
      data: {
        subagent_id: "subagent_1",
        name: "searcher",
        status: "completed",
        summary: "Found the relevant code.",
        evidence: ["packages/agent/src/agent-loop.ts"],
        tool_access: "read-only",
        tool_names: ["semantic_search"],
        started_at: now,
        completed_at: now,
      },
    }

    expect(Codec.decode(Event.Event)(Codec.encode(Event.Event)(event))).toEqual(event)
  })

  test("round-trips remote control API payloads", () => {
    const start: Remote.StartTurnRequest = {
      thread_id: threadId,
      workspace_id: workspaceId,
      content: "Ship remote control",
      content_parts: [Message.text("Ship remote control")],
      mode: "smart",
    }
    const summary: Remote.ThreadSummary = {
      thread_id: threadId,
      workspace_id: workspaceId,
      latest_message_text: "Ship remote control",
      archived: false,
      created_at: now,
      updated_at: now,
    }
    const health: Remote.BackendHealth = {
      status: "healthy",
      url: "http://127.0.0.1:4587",
      workspace_root: "/workspace/rika",
      data_dir: "/workspace/rika/.rika",
      pid: 123,
      version: "0.0.0",
    }
    const subscription: Remote.SubscribeThreadEventsRequest = {
      thread_id: threadId,
      after_sequence: 1,
    }

    expect(Codec.decode(Remote.StartTurnRequest)(Codec.encode(Remote.StartTurnRequest)(start))).toEqual(start)
    expect(Codec.decode(Remote.ThreadSummary)(Codec.encode(Remote.ThreadSummary)(summary))).toEqual(summary)
    expect(Codec.decode(Remote.BackendHealth)(Codec.encode(Remote.BackendHealth)(health))).toEqual(health)
    expect(
      Codec.decode(Remote.SubscribeThreadEventsRequest)(
        Codec.encode(Remote.SubscribeThreadEventsRequest)(subscription),
      ),
    ).toEqual(subscription)
    expect(Codec.decode(Remote.StreamFrame)(Codec.encode(Remote.StreamFrame)(summaryError(401)))).toEqual(
      summaryError(401),
    )
  })

  test("round-trips workspace membership payloads", () => {
    const membership: Workspace.Membership = {
      workspace_id: workspaceId,
      user_id: Ids.UserId.make("user_schema_member"),
      role: "owner",
      created_at: now,
    }
    const decision: Workspace.AccessDecision = {
      allowed: true,
      action: "write",
      workspace_id: workspaceId,
      user_id: membership.user_id,
    }

    expect(Codec.decode(Workspace.Membership)(Codec.encode(Workspace.Membership)(membership))).toEqual(membership)
    expect(Codec.decode(Workspace.AccessDecision)(Codec.encode(Workspace.AccessDecision)(decision))).toEqual(decision)
  })

  test("round-trips IDE integration payloads", () => {
    const clientId = Ids.IdeClientId.make("ide_schema_client")
    const context: Ide.ContextSnapshot = {
      workspace_roots: ["/workspace/rika"],
      active_file: {
        path: "packages/cli/src/runtime.ts",
        language_id: "typescript",
        selection: { range: { start_line: 10, end_line: 12 }, selected_text: "const mode = 'smart'" },
      },
      diagnostics: [
        {
          path: "packages/cli/src/runtime.ts",
          severity: "warning",
          message: "Unused symbol",
          range: { start_line: 11, end_line: 11 },
          source: "tsserver",
        },
      ],
    }
    const connect: Ide.ConnectRequest = {
      client_id: clientId,
      name: "Mock IDE",
      workspace_roots: ["/workspace/rika"],
      capabilities: ["active-context", "diagnostics", "navigation"],
      initial_context: context,
    }
    const start: Remote.StartTurnRequest = {
      thread_id: threadId,
      workspace_id: workspaceId,
      content: "Use the active editor context",
      ide_context: context,
    }
    const openFile: Ide.OpenFileRequest = {
      path: "packages/cli/src/runtime.ts",
      range: { start_line: 10, end_line: 12 },
      reason: "Show the selected code",
      thread_id: threadId,
    }

    expect(Codec.decode(Ide.ConnectRequest)(Codec.encode(Ide.ConnectRequest)(connect))).toEqual(connect)
    expect(Codec.decode(Remote.StartTurnRequest)(Codec.encode(Remote.StartTurnRequest)(start))).toEqual(start)
    expect(Codec.decode(Ide.OpenFileRequest)(Codec.encode(Ide.OpenFileRequest)(openFile))).toEqual(openFile)
  })
})

const summaryError = (status: number): Remote.ApiError => ({
  error: { message: "Unauthorized", code: "unauthorized", details: { status } },
})
