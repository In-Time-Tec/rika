import { expect } from "@effect/vitest"
import { Effect } from "effect"
import type { Turn } from "@rika/product/turn-record"
import type { Interface } from "@rika/product/transcript-repository"
import type { Unit } from "@rika/transcript/transcript-unit"
import * as UnitOrder from "@rika/transcript/transcript-unit-order"
import { completeLeadingTurn, loadTranscriptWindow } from "@rika/product/transcript-window"

export const expectBoundedStructure = (transcripts: Interface, active: Turn) =>
  Effect.gen(function* () {
    const threadId = active.threadId
    const group: Unit = {
      key: "group-unit",
      turnId: active.id,
      revision: 0,
      order: UnitOrder.unitOrder("group-unit", 0),
      content: {
        _tag: "Block",
        block: {
          _tag: "SubagentGroup",
          id: "group",
          name: "Task",
          status: "complete",
          settled: true,
          memberIds: ["member-0", "member-1", "member-2", "member-3"],
          counts: { total: 4, complete: 4, queued: 0, running: 0, waiting: 0, cancelling: 0, failed: 0, cancelled: 0 },
        },
      },
    }
    const groupUnits: Array<Unit> = [group]
    for (let index = 0; index < 4; index++) {
      const id = `member-${index}`
      const member: Unit = {
        key: `${id}:unit`,
        turnId: active.id,
        revision: 0,
        parentId: "group",
        order: UnitOrder.childOrder(group.order, "group", UnitOrder.unitOrder(`${id}:unit`, index)),
        content: {
          _tag: "Block",
          block: {
            _tag: "SubagentCard",
            id,
            name: "Task",
            prompt: id,
            promptTruncated: false,
            summary: "",
            status: "complete",
            activity: [],
          },
        },
      }
      groupUnits.push(
        member,
        ...Array.from({ length: 80 }, (_, output): Unit => {
          const childKey = `${id}:output:${output}`
          return {
            key: childKey,
            turnId: active.id,
            revision: 0,
            parentId: id,
            order: UnitOrder.childOrder(member.order, id, UnitOrder.unitOrder(childKey, output)),
            content: { _tag: "Entry", role: "assistant", text: childKey },
          }
        }),
      )
    }
    yield* transcripts.replaceUnits(active, groupUnits)
    const partialGroup = yield* transcripts.page(threadId, { limit: 120 })
    const structural = yield* transcripts.page(threadId, { structuralTurnId: active.id, limit: 2 })
    expect(structural.entries.map(({ unit }) => unit.key)).toEqual(["group-unit", "member-0:unit"])
    expect(structural.hasNewer).toBe(true)
    expect(structural.hasOlder).toBe(false)
    const completedGroup = yield* completeLeadingTurn(partialGroup, transcripts)
    expect(
      completedGroup.entries.filter(
        ({ unit }) => unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard",
      ),
    ).toHaveLength(4)
    expect(completedGroup.oldestCursor).toEqual(partialGroup.oldestCursor)
    const preceding = yield* transcripts.page(threadId, { before: completedGroup.oldestCursor, limit: 1 })
    expect(preceding.entries[0]?.unit.key).toBe("member-2:output:40")
    // A replacement may reuse the revision: generation must fence structural completion too.
    yield* transcripts.replaceUnits(
      active,
      groupUnits.filter((unit) => unit !== group),
    )
    expect(yield* completeLeadingTurn(partialGroup, transcripts)).toBe(partialGroup)
    const staleWindow = yield* loadTranscriptWindow(threadId, {
      page: (id, options) =>
        options?.structuralTurnId === undefined ? Effect.succeed(partialGroup) : transcripts.page(id, options),
    })
    expect(staleWindow.entries).toEqual([])
    expect(staleWindow.hasOlder).toBe(true)
    expect(staleWindow.oldestCursor).toEqual(partialGroup.oldestCursor)
    expect((yield* loadTranscriptWindow(threadId, transcripts)).entries).toEqual([])
  })
