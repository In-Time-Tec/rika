import { expect, it } from "@effect/vitest"
import { ToolContext } from "@batonfx/core"
import { AgentDirectory, Runtime } from "@batonfx/runtime"
import { AgentPort, ChildSettlementInboxEntry, type Interface as AgentPortInterface } from "@rika/kernel/agent-port"
import * as ArtifactStore from "@rika/kernel/artifact-store"
import { Context, Effect, Layer } from "effect"
import { Prompt } from "effect/unstable/ai"
import { runtimeAgentPortLayer } from "../src/server/composition/server-agent-port"

const cellContext = (runId: string, toolCallId = "call-1") =>
  ToolContext.ToolContext.of({
    signal: new AbortController().signal,
    emit: () => Effect.void,
    sessionId: "session-a",
    runId,
    toolCallId,
    operationKey: "operation-1",
  })

const runInspection = (runId: string, parentRunId?: string) => ({
  runId,
  status: "running" as const,
  executableRef: {} as never,
  executableManifest: {} as never,
  lastSequence: 0,
  durability: "durable" as const,
  ...(parentRunId === undefined ? {} : { parentRunId }),
})

const directoryEntry = (runId: string, parentRunId?: string) => ({
  address: AgentDirectory.runAddress(runId),
  runId,
  rootRunId: "root",
  sessionId: `session-${runId}`,
  status: "running" as const,
  ...(parentRunId === undefined ? {} : { parentRunId }),
})

type RuntimeOverrides = Partial<Runtime.Interface> & {
  readonly childSettlements?: (input: {
    readonly parentRunId: string
    readonly afterSequence?: number
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<typeof ChildSettlementInboxEntry.Type>, never>
}

const runtimeOf = (overrides: RuntimeOverrides) => Runtime.Runtime.of(overrides as Runtime.Interface)

const artifacts = ArtifactStore.layerTest({
  put: (input) => Effect.succeed({ id: `artifact-${String(input.value).length}`, bytes: String(input.value).length }),
  get: () => Effect.void,
})

/**
 * The port reads the executing cell's identity per call rather than at layer build, so the ambient
 * context is supplied around each use rather than merged into the layer that produced the port.
 */
const withPort = <A, E>(
  runtime: RuntimeOverrides,
  use: (port: AgentPortInterface) => Effect.Effect<A, E>,
  runId = "run-self",
  toolCallId = "call-1",
) =>
  Effect.scoped(
    Effect.flatMap(Layer.build(runtimeAgentPortLayer.pipe(Layer.provide(artifacts))), (context) =>
      use(Context.get(context, AgentPort)).pipe(
        Effect.provideService(ToolContext.ToolContext, cellContext(runId, toolCallId)),
        Effect.provideService(Runtime.Runtime, runtimeOf({ history: () => Effect.succeed([]), ...runtime })),
      ),
    ),
  )

it.effect("reports Baton's duplicate admission rather than always claiming a fresh child", () =>
  Effect.gen(function* () {
    const admitted = yield* withPort(
      {
        spawn: () => Effect.succeed({ runId: "child-1", messageId: "m", acceptedSequence: 1, duplicate: true }),
        inspect: () => Effect.succeed(runInspection("run-self") as never),
        inspectTree: () =>
          Effect.succeed({
            _tag: "Active",
            rootRunId: "run-self",
            cursor: "c",
            runs: [],
            usage: [],
            compactions: [],
            activeRunIds: [],
          } as never),
      },
      (value) => value.spawn({ profile: "Task", prompt: "p", key: "k" }),
    )
    // A replayed cell must learn the child already existed; reporting `false` would spawn twice.
    expect(admitted).toEqual({ childRunId: "child-1", key: "k", duplicate: true })
  }),
)

it.effect("maps every Baton run status onto a status the cell contract names", () =>
  Effect.gen(function* () {
    const statuses = [
      "queued",
      "needs-resolution",
      "running",
      "waiting",
      "cancelling",
      "succeeded",
      "failed",
      "cancelled",
    ] as const
    const seen: Array<string> = []
    for (const status of statuses) {
      const mapped = yield* withPort(
        {
          inspect: () => Effect.succeed(runInspection("run-self") as never),
          inspectTree: () =>
            Effect.succeed({
              _tag: "Active",
              rootRunId: "run-self",
              cursor: "c" as never,
              runs: [{ run: { ...runInspection("child-1"), status }, parentRunId: "run-self" }],
              usage: [],
              compactions: [],
              activeRunIds: [],
            } as never),
        },
        (value) => value.inspect("child-1"),
      )
      seen.push(mapped.status)
    }
    // `queued` and `needs-resolution` both mean admitted-but-not-producing; nothing leaks unmapped.
    expect(seen).toEqual(["pending", "pending", "running", "waiting", "cancelling", "succeeded", "failed", "cancelled"])
  }),
)

it.effect("adds the latest durable activity preview when inspecting a running child", () =>
  Effect.gen(function* () {
    const inspected = yield* withPort(
      {
        inspect: (runId) => Effect.succeed(runInspection(runId) as never),
        inspectTree: () =>
          Effect.succeed({
            _tag: "Active",
            rootRunId: "run-self",
            cursor: "c" as never,
            runs: [{ run: runInspection("child-1"), parentRunId: "run-self" }],
            usage: [],
            compactions: [],
            activeRunIds: ["child-1"],
          } as never),
        history: () =>
          Effect.succeed([
            {
              _tag: "ToolProgress",
              occurredAt: "2026-08-10T20:35:48.000Z",
              message: "reviewing the durable inbox adapter",
            },
          ] as never),
      },
      (value) => value.inspect("child-1"),
    )

    expect(inspected).toMatchObject({
      childRunId: "child-1",
      status: "running",
      lastActivityAt: "2026-08-10T20:35:48.000Z",
      latestStep: "reviewing the durable inbox adapter",
    })
  }),
)

it.effect("inspects any number of direct children with one durable tree read", () =>
  Effect.gen(function* () {
    const childRunIds = Array.from({ length: 96 }, (_, index) => `child-${index}`)
    let treeReads = 0
    const children = yield* withPort(
      {
        inspect: () => Effect.succeed(runInspection("run-self") as never),
        inspectTree: () => {
          treeReads = treeReads + 1
          return Effect.succeed({
            _tag: "Active",
            rootRunId: "run-self",
            cursor: "c" as never,
            runs: childRunIds.map((runId) => ({ run: runInspection(runId), parentRunId: "run-self" })),
            usage: [],
            compactions: [],
            activeRunIds: childRunIds,
          } as never)
        },
      },
      (value) => value.inspectAll(childRunIds),
    )
    expect(treeReads).toBe(1)
    expect(children.map(({ childRunId }) => childRunId)).toEqual(childRunIds)
  }),
)

it.effect("sends to the address the cell named instead of forcing every address to a session", () =>
  Effect.gen(function* () {
    const addresses: Array<string> = []
    yield* withPort(
      {
        sendMessage: (input) => {
          addresses.push(String(input.to))
          return Effect.succeed({ messageId: "m", entryId: "e", sequence: 1, duplicate: false })
        },
      },
      (value) =>
        value
          .send({ to: "run:child-1", prompt: "hello", idempotencyKey: "k" })
          .pipe(Effect.andThen(value.send({ to: "session:thread-b", prompt: "hello", idempotencyKey: "k2" }))),
    )
    // A run address must stay a run address; coercing it to `session:run:child-1` addresses nothing.
    expect(addresses).toEqual(["run:child-1", "session:thread-b"])
  }),
)

it.effect("sends under the ambient Run identity, never an address the cell supplied", () =>
  Effect.gen(function* () {
    const senders: Array<string> = []
    yield* withPort(
      {
        sendMessage: (input) => {
          senders.push(input.fromRunId)
          return Effect.succeed({ messageId: "m", entryId: "e", sequence: 1, duplicate: false })
        },
      },
      (value) => value.send({ to: "run:victim", prompt: "hello", idempotencyKey: "k" }),
      "run-self",
    )
    expect(senders).toEqual(["run-self"])
  }),
)

it.effect("gives the cell the message text a sender wrote, not the serialized envelope", () =>
  Effect.gen(function* () {
    const entries = yield* withPort(
      {
        messages: () =>
          Effect.succeed([
            {
              entryId: "e1",
              targetSessionId: "session-a",
              sequence: 1,
              from: AgentDirectory.runAddress("run-b"),
              fromRunId: "run-b",
              to: AgentDirectory.runAddress("run-self"),
              messageId: "m1",
              idempotencyKey: "k",
              digest: "d",
              bytes: 4,
              admittedAtMillis: 0,
              prompt: Prompt.make("the answer is 42"),
              correlationId: "c",
              metadata: {},
            },
          ] as never),
        childSettlements: () => Effect.succeed([]),
      },
      (value) => value.inbox({ limit: 10 }),
    )
    expect(entries[0]).toMatchObject({ _tag: "Message", prompt: "the answer is 42" })
  }),
)

it.effect("reads durable bounded child settlements by cursor without duplicating their mailbox envelopes", () =>
  Effect.gen(function* () {
    const calls: Array<{ readonly parentRunId: string; readonly afterSequence?: number; readonly limit: number }> = []
    const entries = yield* withPort(
      {
        messages: () =>
          Effect.succeed([
            {
              entryId: "ordinary-message",
              sequence: 5,
              from: AgentDirectory.runAddress("run-b"),
              prompt: Prompt.make("ordinary"),
              messageId: "ordinary-message",
            },
            {
              entryId: "child-settled:child-1",
              sequence: 6,
              from: AgentDirectory.runAddress("child-1"),
              prompt: Prompt.make("duplicated envelope"),
              messageId: "child-settled:child-1",
            },
          ] as never),
        childSettlements: (input: {
          readonly parentRunId: string
          readonly afterSequence?: number
          readonly limit: number
        }) => {
          calls.push(input)
          return Effect.succeed([
            {
              _tag: "ChildSettlement" as const,
              notificationId: "child-settled:child-1",
              parentRunId: "run-self",
              childRunId: "child-1",
              terminalEventId: "terminal-1",
              status: "succeeded" as const,
              resultText: "bounded child result",
              resultBytes: 20,
              resultTruncated: false,
              sequence: 6,
              admittedAtMillis: 100,
            },
          ])
        },
      },
      (value) => value.inbox({ afterSequence: 4, limit: 10 }),
    )

    expect(calls).toEqual([{ parentRunId: "run-self", afterSequence: 4, limit: 10 }])
    expect(entries).toEqual([
      {
        _tag: "Message",
        entryId: "ordinary-message",
        sequence: 5,
        from: "run:run-b",
        prompt: "ordinary",
        messageId: "ordinary-message",
      },
      {
        _tag: "ChildSettlement",
        notificationId: "child-settled:child-1",
        parentRunId: "run-self",
        childRunId: "child-1",
        terminalEventId: "terminal-1",
        status: "succeeded",
        resultText: "bounded child result",
        resultBytes: 20,
        resultTruncated: false,
        sequence: 6,
        admittedAtMillis: 100,
      },
    ])
  }),
)

it.effect("replaces Baton's internal large-result recovery marker with a Rika artifact handle", () =>
  Effect.gen(function* () {
    const entries = yield* withPort(
      {
        messages: () => Effect.succeed([]),
        childSettlements: () =>
          Effect.succeed([
            {
              _tag: "ChildSettlement" as const,
              notificationId: "child-settled:child-1",
              parentRunId: "run-self",
              childRunId: "child-1",
              terminalEventId: "terminal-1",
              status: "succeeded" as const,
              resultText: '[Result omitted. Recover it with Runtime.snapshot("child-1").]',
              resultBytes: 345_000,
              resultTruncated: true,
              sequence: 3,
              admittedAtMillis: 100,
            },
          ]),
        snapshot: () =>
          Effect.succeed({
            outcome: { _tag: "Succeeded", result: { text: "x".repeat(345_000) } },
          } as never),
      },
      (value) => value.inbox({ limit: 10 }),
    )

    expect(entries[0]).toMatchObject({
      _tag: "ChildSettlement",
      resultArtifact: { id: "artifact-345000", bytes: 345_000 },
    })
    if (entries[0]?._tag === "ChildSettlement") {
      expect(entries[0].resultText).toContain('rika.artifacts.get({ id: "artifact-345000" })')
      expect(entries[0].resultText).not.toContain("Runtime.snapshot")
    }
  }),
)

it.effect("keeps delivered settlements readable when the pending message inbox is empty", () =>
  Effect.gen(function* () {
    const entries = yield* withPort(
      {
        messages: () => Effect.succeed([]),
        childSettlements: () =>
          Effect.succeed([
            {
              _tag: "ChildSettlement" as const,
              notificationId: "child-settled:child-1",
              parentRunId: "run-self",
              childRunId: "child-1",
              terminalEventId: "terminal-1",
              status: "failed" as const,
              resultText: "AgentExecutionFailure: provider rejected the child request",
              resultBytes: 58,
              resultTruncated: false,
              sequence: 3,
              admittedAtMillis: 100,
            },
          ]),
      },
      (value) => value.inbox({ limit: 10 }),
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      _tag: "ChildSettlement",
      status: "failed",
      resultText: "AgentExecutionFailure: provider rejected the child request",
    })
  }),
)

it.effect("derives each directory relationship from durable parentage rather than calling all of them children", () =>
  Effect.gen(function* () {
    const entries = yield* withPort(
      {
        inspect: () => Effect.succeed(runInspection("run-self", "run-parent") as never),
        directory: () =>
          Effect.succeed([
            directoryEntry("run-parent"),
            directoryEntry("run-child", "run-self"),
            directoryEntry("run-sibling", "run-parent"),
            directoryEntry("run-stranger", "run-elsewhere"),
          ] as never),
      },
      (value) => value.directory,
    )
    expect(entries.map((entry) => entry.relationship)).toEqual(["parent", "child", "sibling", "policy"])
  }),
)

it.effect("scopes a spawn's ordinal to the cell that admitted it, not to the profile alone", () =>
  Effect.gen(function* () {
    // The admission key names the profile and its ordinal; the cell it belongs to is named by the
    // invocation Baton composes around it, which carries the tool call twice over — once directly and
    // once through the origin. Two cells spawning one profile must still be told apart.
    const invocations: Array<{ readonly toolCallId: string; readonly invocationId: string }> = []
    const runtime = (toolCallId: string) => ({
      spawn: (input: { readonly invocationId: string }) => {
        invocations.push({ toolCallId, invocationId: input.invocationId })
        return Effect.succeed({ runId: "child", messageId: "m", acceptedSequence: 1, duplicate: false })
      },
      inspect: () => Effect.succeed(runInspection("run-self") as never),
      inspectTree: () =>
        Effect.succeed({
          _tag: "Active",
          rootRunId: "run-self",
          cursor: "c",
          runs: [],
          usage: [],
          compactions: [],
          activeRunIds: [],
        } as never),
    })
    for (const toolCallId of ["call-a", "call-b"])
      yield* withPort(
        runtime(toolCallId) as never,
        (value) => value.spawn({ profile: "Task", prompt: "p", key: "Task#0" }),
        "run-self",
        toolCallId,
      )
    expect(invocations.map(({ toolCallId }) => toolCallId)).toEqual(["call-a", "call-b"])
    expect(invocations[0]?.invocationId).not.toBe(invocations[1]?.invocationId)
    for (const { toolCallId, invocationId } of invocations) expect(invocationId).toContain(toolCallId)
  }),
)

it.effect("tells the cell what refused a spawn instead of an empty line", () =>
  Effect.gen(function* () {
    // A tagged failure keeps its account in its own `message`, and stringifying the object produced
    // nothing. A cell told only that a spawn failed cannot tell a bad profile from a closed run.
    const failure = yield* Effect.flip(
      withPort(
        {
          spawn: () => Effect.fail({ _tag: "@batonfx/runtime/ChildSelectionMissing", selection: "Task" } as never),
          inspect: () => Effect.succeed(runInspection("run-self") as never),
          inspectTree: () =>
            Effect.succeed({
              _tag: "Active",
              rootRunId: "run-self",
              cursor: "c",
              runs: [],
              usage: [],
              compactions: [],
              activeRunIds: [],
            } as never),
        },
        (value) => value.spawn({ profile: "Task", prompt: "p", key: "k" }),
      ),
    )
    expect(failure.message).toContain("ChildSelectionMissing")
    expect(failure.message).toContain("selection=Task")
  }),
)
