import * as TranscriptPage from "@rika/product/transcript-page"
import * as ExecutionEvent from "@rika/product/execution-event"
import * as ExecutionInspection from "@rika/product/execution-inspection"
import { describe, expect, it } from "@effect/vitest"
import {
  RuntimeFixtures,
  TranscriptFixtures,
  Effect,
  subagentToolId,
  subagentChildId,
  subagentRootEvents,
  subagentChildEvents,
  makeSubagentReloadHarness,
  selectionEntriesFor,
} from "./interactive-session-reload-support"

describe("InteractiveSession subagent reload", () => {
  it.effect("refolds terminal child outcomes from Relay after a projection-version change", () =>
    Effect.gen(function* () {
      const failedRootEvents: ReadonlyArray<RuntimeFixtures.ExecutionEvent.Event> = [
        ...subagentRootEvents.slice(0, 3),
        {
          executionId: "execution:done",
          cursor: "failed-root",
          sequence: 3,
          type: "execution.failed",
          createdAt: 5,
          text: "root failed after delegation",
        },
      ]
      const failedRoot = TranscriptFixtures.TranscriptProjection.Projection.project(
        "done",
        "delegate",
        failedRootEvents,
      )
      const completedChild = TranscriptFixtures.TranscriptProjection.Projection.project(
        subagentChildId,
        "",
        subagentChildEvents,
      )
      const storedTree = TranscriptFixtures.TranscriptNestedProjection.withNestedProjections(failedRoot, [
        { parentId: subagentToolId, projection: completedChild },
      ])
      const { session, subagentThread } = yield* makeSubagentReloadHarness({
        storedTree,
        turnLastCursor: "failed-root",
        childReplayEvents: subagentChildEvents,
        turnStatus: "failed",
        replayEvents: (executionId) => (executionId === "done" ? failedRootEvents : subagentChildEvents),
        projectionVersion: RuntimeFixtures.TranscriptRepository.invalidatedProjectionVersion,
      })

      const reconciledParent = (entries: ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry>) =>
        entries.find(
          (entry) =>
            entry.unit.parentId === undefined &&
            entry.unit.content._tag === "Block" &&
            entry.unit.content.block._tag === "ToolCall" &&
            entry.unit.content.block.id === subagentToolId,
        )
      const { entries } = yield* selectionEntriesFor(session, subagentThread.id, (loaded) => {
        const content = reconciledParent(loaded)?.unit.content
        return content?._tag === "Block" && content.block._tag === "ToolCall" && content.block.status === "complete"
      })
      const parent = reconciledParent(entries)
      expect(parent?.unit.content).toMatchObject({
        _tag: "Block",
        block: { _tag: "ToolCall", status: "complete" },
      })
      expect(
        entries.some(
          (entry) =>
            entry.unit.content._tag === "Block" &&
            entry.unit.content.block._tag === "Error" &&
            entry.unit.content.block.detail === "root failed after delegation",
        ),
      ).toBe(true)
    }),
  )

  it.effect("rebuilds a failed root and terminal descendant tree in a replacement session", () =>
    Effect.gen(function* () {
      const completedChildId = "child:execution%3Adone:completed"
      const failedChildId = "child:execution%3Adone:failed"
      const nestedChildId = `child:${encodeURIComponent(completedChildId)}:nested`
      const rootEvents: ReadonlyArray<RuntimeFixtures.ExecutionEvent.Event> = [
        {
          executionId: "execution:done",
          cursor: "root-completed-tool",
          sequence: 0,
          type: "tool.call.requested",
          createdAt: 1,
          data: { tool_call_id: "completed", tool_name: "task", input: { prompt: "complete" } },
        },
        {
          executionId: "execution:done",
          cursor: "root-completed-spawn",
          sequence: 1,
          type: "child_run.spawned",
          createdAt: 2,
          data: { tool_call_id: "completed", child_execution_id: completedChildId },
        },
        {
          executionId: "execution:done",
          cursor: "root-failed-tool",
          sequence: 2,
          type: "tool.call.requested",
          createdAt: 2,
          data: { tool_call_id: "failed", tool_name: "task", input: { prompt: "fail" } },
        },
        {
          executionId: "execution:done",
          cursor: "root-failed-spawn",
          sequence: 3,
          type: "child_run.spawned",
          createdAt: 3,
          data: { tool_call_id: "failed", child_execution_id: failedChildId },
        },
        {
          executionId: "execution:done",
          cursor: "root-usage",
          sequence: 4,
          type: "model.usage.reported",
          createdAt: 7,
          data: {
            model_call_id: "root-call",
            model_attempt_id: "root-attempt",
            attempt: 1,
            provider: "openai",
            model: "gpt-5.6-sol",
            input_tokens: 20,
            input_tokens_uncached: 20,
            input_tokens_cache_read: 0,
            input_tokens_cache_write: 0,
            output_tokens: 10,
          },
        },
        {
          executionId: "execution:done",
          cursor: "root-cost",
          sequence: 5,
          type: "model.attempt.completed",
          createdAt: 7,
          data: {
            model_call_id: "root-call",
            model_attempt_id: "root-attempt",
            attempt: 1,
            cost: { amount: 1.25, currency: "USD" },
          },
        },
        {
          executionId: "execution:done",
          cursor: "root-failed",
          sequence: 6,
          type: "execution.failed",
          createdAt: 8,
          text: "resident was replaced during execution",
        },
      ]
      const completedChildEvents: ReadonlyArray<RuntimeFixtures.ExecutionEvent.Event> = [
        {
          executionId: completedChildId,
          cursor: "nested-tool",
          sequence: 0,
          type: "tool.call.requested",
          createdAt: 3,
          data: { tool_call_id: "nested", tool_name: "task", input: { prompt: "nested work" } },
        },
        {
          executionId: completedChildId,
          cursor: "nested-spawn",
          sequence: 1,
          type: "child_run.spawned",
          createdAt: 4,
          data: { tool_call_id: "nested", child_execution_id: nestedChildId },
        },
        {
          executionId: completedChildId,
          cursor: "completed-child",
          sequence: 2,
          type: "execution.completed",
          createdAt: 7,
        },
      ]
      const failedChildEvents: ReadonlyArray<RuntimeFixtures.ExecutionEvent.Event> = [
        {
          executionId: failedChildId,
          cursor: "failed-child",
          sequence: 0,
          type: "execution.failed",
          createdAt: 6,
          text: "child checks failed",
        },
      ]
      const nestedChildEvents: ReadonlyArray<RuntimeFixtures.ExecutionEvent.Event> = [
        {
          executionId: nestedChildId,
          cursor: "nested-answer",
          sequence: 0,
          type: "model.output.completed",
          createdAt: 5,
          text: "Nested child completed authoritatively.",
        },
        {
          executionId: nestedChildId,
          cursor: "nested-completed",
          sequence: 1,
          type: "execution.completed",
          createdAt: 6,
        },
      ]
      const stale = TranscriptFixtures.TranscriptProjection.Projection.project(
        "done",
        "delegate",
        rootEvents.slice(0, 4),
      )
      const inspections: Readonly<Record<string, RuntimeFixtures.ExecutionInspection.Inspection>> = {
        done: {
          turnId: "done",
          status: "failed",
          lastCursor: "root-failed",
          waits: [],
          pendingTools: [],
          children: [
            { executionId: completedChildId, status: "completed" },
            { executionId: failedChildId, status: "failed" },
          ],
        },
        [completedChildId]: {
          turnId: completedChildId,
          status: "completed",
          lastCursor: "completed-child",
          waits: [],
          pendingTools: [],
          children: [{ executionId: nestedChildId, status: "completed" }],
        },
        [failedChildId]: {
          turnId: failedChildId,
          status: "failed",
          lastCursor: "failed-child",
          waits: [],
          pendingTools: [],
          children: [],
        },
        [nestedChildId]: {
          turnId: nestedChildId,
          status: "completed",
          lastCursor: "nested-completed",
          waits: [],
          pendingTools: [],
          children: [],
        },
      }
      const replayEvents: Readonly<Record<string, ReadonlyArray<RuntimeFixtures.ExecutionEvent.Event>>> = {
        done: rootEvents,
        [completedChildId]: completedChildEvents,
        [failedChildId]: failedChildEvents,
        [nestedChildId]: nestedChildEvents,
      }
      const { session, subagentThread } = yield* makeSubagentReloadHarness({
        storedTree: stale,
        turnLastCursor: "root-failed-spawn",
        childReplayEvents: [],
        turnStatus: "running",
        inspection: (executionId) => inspections[executionId],
        replayEvents: (executionId) => replayEvents[executionId] ?? [],
        projectionVersion: RuntimeFixtures.TranscriptRepository.invalidatedProjectionVersion,
      })

      const { entries, events } = yield* selectionEntriesFor(session, subagentThread.id)
      for (
        let attempt = 0;
        attempt < 400 &&
        !events.some(
          (event) =>
            event._tag === "ThreadUsageUpdated" && event.cost._tag === "Available" && event.tokens._tag === "Available",
        );
        attempt += 1
      )
        yield* Effect.yieldNow
      const root = entries.filter((entry) => entry.turn.id === "done" && entry.unit.parentId === undefined)
      const tools = root.flatMap((entry) =>
        entry.unit.content._tag === "Block" && entry.unit.content.block._tag === "ToolCall"
          ? [entry.unit.content.block]
          : [],
      )

      expect(
        root.every(
          (entry) =>
            RuntimeFixtures.ThreadResult.TurnResult.isAgentExecution(entry.turn) &&
            entry.turn.status === "failed" &&
            entry.turn.lastCursor === "root-failed",
        ),
      ).toBe(true)
      expect(root).toContainEqual(
        expect.objectContaining({
          unit: expect.objectContaining({
            content: expect.objectContaining({
              block: expect.objectContaining({
                _tag: "Error",
                title: "Execution failed",
                detail: "resident was replaced during execution",
              }),
            }),
          }),
        }),
      )
      expect(tools).toEqual([
        expect.objectContaining({ id: "done:completed", status: "complete" }),
        expect.objectContaining({ id: "done:failed", status: "failed" }),
      ])
      expect(
        entries.find(
          (entry) =>
            entry.unit.turnId === completedChildId &&
            entry.unit.content._tag === "Block" &&
            entry.unit.content.block._tag === "ToolCall" &&
            entry.unit.content.block.id ===
              TranscriptFixtures.TranscriptIdentity.scopedIdentity(completedChildId, "nested"),
        )?.unit.content,
      ).toMatchObject({ _tag: "Block", block: { _tag: "ToolCall", status: "complete" } })
      expect(
        entries.some(
          (entry) =>
            entry.unit.turnId === nestedChildId &&
            entry.unit.content._tag === "Entry" &&
            entry.unit.content.text === "Nested child completed authoritatively.",
        ),
      ).toBe(true)
      expect(
        entries.some(
          (entry) =>
            entry.unit.content._tag === "Block" &&
            (entry.unit.content.block._tag === "ToolCall" || entry.unit.content.block._tag === "ChildAgent") &&
            entry.unit.content.block.status === "running",
        ),
      ).toBe(false)
      expect(events.findLast((event) => event._tag === "ThreadUsageUpdated")).toMatchObject({
        _tag: "ThreadUsageUpdated",
        selectionEpoch: 1,
        threadId: "subagent-thread",
        cost: { _tag: "Available", usd: 1.25, unpricedAttempts: 0 },
        tokens: { _tag: "Available", total: 30, uncountedAttempts: 0 },
        time: { _tag: "Available" },
      })
    }),
  )
})
