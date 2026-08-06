import { describe, expect, it } from "@effect/vitest"
import { Duration } from "effect"
import * as Support from "./usage-test-support"

describe("UsageCost", () => {
  it("ignores transient delta events entirely", () => {
    const accepted = Support.UsageCost.observe(Support.UsageCost.empty, {
      threadId: "thread",
      turnId: "turn",
      event: Support.Fixtures.lifecycle("execution", "accepted", "execution.accepted", 1_000, 1),
    })
    const next = Support.UsageCost.observe(accepted, {
      threadId: "thread",
      turnId: "turn",
      event: {
        executionId: "execution",
        cursor: "delta-1",
        sequence: 1,
        type: "model.output.delta",
        createdAt: 2_000,
        data: { delta: "x", transient_index: 1 },
      },
    })

    expect(next).toBe(accepted)
  })

  it("keeps accepted and never-started cancelled executions at zero active time", () => {
    const accepted = Support.UsageCost.observe(Support.UsageCost.empty, {
      threadId: "thread",
      turnId: "turn",
      event: Support.Fixtures.lifecycle("execution", "accepted", "execution.accepted", 1_000, 1),
    })
    const cancelled = Support.UsageCost.observe(accepted, {
      threadId: "thread",
      turnId: "turn",
      event: Support.Fixtures.lifecycle("execution", "cancelled", "execution.cancelled", 2_000, 2),
    })

    expect(Support.UsageCost.activeTime(accepted, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.zero,
    })
    expect(Support.UsageCost.activeTime(cancelled, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.zero,
    })
  })

  it("starts an accepted execution when the live started event arrives", () => {
    const accepted = Support.UsageCost.observe(Support.UsageCost.empty, {
      threadId: "thread",
      turnId: "turn",
      event: Support.Fixtures.lifecycle("execution", "accepted", "execution.accepted", 1_000, 1),
    })
    const started = Support.UsageCost.observe(accepted, {
      threadId: "thread",
      turnId: "turn",
      event: Support.Fixtures.lifecycle("execution", "started", "execution.started", 2_000, 2),
    })

    expect(Support.UsageCost.activeTime(started, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.zero,
      activeSince: 2_000,
    })
  })

  it("accumulates execution work across durable waits and resumes", () => {
    const snapshot = [
      Support.Fixtures.lifecycle("execution", "start-1", "execution.started", 1_000, 1),
      Support.Fixtures.lifecycle("execution", "wait", "wait.created", 11_000, 2),
      Support.Fixtures.lifecycle("execution", "wake", "wait.woken", 15_000, 3),
      Support.Fixtures.lifecycle("execution", "complete", "execution.completed", 20_000, 4),
    ].reduce(
      (current, event) => Support.UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      Support.UsageCost.empty,
    )

    expect(Support.UsageCost.activeTime(snapshot, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(15),
    })
  })

  it("closes an execution interval at its server-stamped terminal timestamp", () => {
    const snapshot = Support.Fixtures.fold([
      Support.Fixtures.lifecycle("execution", "start", "execution.started", 1_000, 1),
      Support.Fixtures.work("execution", "output", "model.output.delta", 5_000, 2),
      Support.Fixtures.lifecycle("execution", "complete", "execution.completed", 1_000, 3),
    ])

    expect(Support.UsageCost.activeTime(snapshot, "thread")).toEqual({ _tag: "Available", accumulated: Duration.zero })
  })

  it("ignores model and tool timestamps when measuring active time", () => {
    const lifecycleOnly = Support.Fixtures.fold([
      Support.Fixtures.lifecycle("execution", "start", "execution.started", 1_000, 1),
      Support.Fixtures.lifecycle("execution", "wait", "wait.created", 6_000, 4),
    ])
    const withWork = Support.Fixtures.fold([
      Support.Fixtures.lifecycle("execution", "start", "execution.started", 1_000, 1),
      Support.Fixtures.work("execution", "tool", "tool.call.requested", 5_000, 2),
      Support.Fixtures.work("execution", "output", "model.output.delta", 90_000, 3),
      Support.Fixtures.lifecycle("execution", "wait", "wait.created", 6_000, 4),
    ])

    expect(
      Support.UsageCost.isObservedEvent(Support.Fixtures.work("execution", "tool", "tool.call.requested", 5_000, 2)),
    ).toBe(false)
    expect(Support.UsageCost.activeTime(withWork, "thread")).toEqual(
      Support.UsageCost.activeTime(lifecycleOnly, "thread"),
    )
    expect(Support.UsageCost.activeTime(withWork, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(5),
    })
  })

  it("accounts for parallel waits until every wait settles", () => {
    const snapshot = Support.Fixtures.fold([
      Support.Fixtures.lifecycle("execution", "start", "execution.started", 1_000, 1),
      Support.Fixtures.lifecycle("execution", "wait-a", "wait.created", 10_000, 2),
      Support.Fixtures.lifecycle("execution", "wait-b", "wait.created", 11_000, 3),
      Support.Fixtures.lifecycle("execution", "wake-a", "wait.woken", 15_000, 4),
      Support.Fixtures.lifecycle("execution", "cancel-b", "wait.cancelled", 20_000, 5),
      Support.Fixtures.lifecycle("execution", "complete", "execution.completed", 22_000, 6),
    ])

    expect(Support.UsageCost.activeTime(snapshot, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(11),
    })
  })

  it("resumes active time from a durable wait cancellation", () => {
    const snapshot = Support.Fixtures.fold([
      Support.Fixtures.lifecycle("execution", "start", "execution.started", 1_000, 1),
      Support.Fixtures.lifecycle("execution", "wait", "wait.created", 2_000, 2),
      Support.Fixtures.lifecycle("execution", "cancel", "wait.cancelled", 10_000, 3),
      Support.Fixtures.lifecycle("execution", "complete", "execution.completed", 12_000, 4),
    ])

    expect(Support.UsageCost.activeTime(snapshot, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(3),
    })
  })

  it("resumes active time from a durable wait timeout", () => {
    const snapshot = Support.Fixtures.fold([
      Support.Fixtures.lifecycle("execution", "start-1", "execution.started", 1_000, 1),
      Support.Fixtures.lifecycle("execution", "wait", "wait.created", 2_000, 7),
      Support.Fixtures.lifecycle("execution", "timeout", "wait.timed_out", 10_000, 12),
      Support.Fixtures.lifecycle("execution", "complete", "execution.completed", 12_000, 14),
    ])

    expect(Support.UsageCost.activeTime(snapshot, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(3),
    })
  })

  it("resumes active time when Baton continues directly from a durable wake", () => {
    const snapshot = Support.Fixtures.fold([
      Support.Fixtures.lifecycle("execution", "start", "execution.started", 1_000, 1),
      Support.Fixtures.lifecycle("execution", "wait", "wait.created", 2_000, 7),
      Support.Fixtures.lifecycle("execution", "wake", "wait.woken", 10_000, 12),
      Support.Fixtures.lifecycle("execution", "complete", "execution.completed", 12_000, 27),
    ])

    expect(Support.UsageCost.activeTime(snapshot, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(3),
    })
  })

  it("does not change the fold for appended streaming deltas", () => {
    const resumed = Support.Fixtures.fold([
      Support.Fixtures.lifecycle("execution", "start", "execution.started", 1_000, 1),
      Support.Fixtures.lifecycle("execution", "wait", "wait.created", 2_000, 7),
      Support.Fixtures.lifecycle("execution", "wake", "wait.woken", 10_000, 12),
    ])
    const streamed = Support.Fixtures.fold(
      Array.from({ length: 2_000 }, (_, index) =>
        Support.Fixtures.work("execution", `output-${index}`, "model.output.delta", 10_001 + index, 14 + index),
      ),
      { threadId: "thread", turnId: "turn" },
      resumed,
    )

    expect(streamed).toBe(resumed)
    expect(Support.UsageCost.activeTime(streamed, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(1),
      activeSince: 10_000,
    })
  })

  it("the compatibility test fold leaves rejected lifecycle evidence out", () => {
    const snapshot = Support.Fixtures.fold([
      Support.Fixtures.lifecycle("healthy", "start", "execution.started", 1_000, 1),
      Support.Fixtures.lifecycle("healthy", "complete", "execution.completed", 4_000, 2),
      Support.Fixtures.lifecycle("conflicted", "start", "execution.started", 1_000, 1),
      Support.Fixtures.lifecycle("conflicted", "start", "execution.started", 9_000, 1),
      Support.Fixtures.lifecycle("conflicted", "complete", "execution.completed", 20_000, 2),
    ])

    expect(Support.UsageCost.activeTime(snapshot, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(19),
    })
  })

  it("orders lifecycle evidence by durable sequence instead of delivery order", () => {
    const events = [
      Support.Fixtures.lifecycle("execution", "start-1", "execution.started", 1_000, 1),
      Support.Fixtures.lifecycle("execution", "wait", "wait.created", 6_000, 2),
      Support.Fixtures.lifecycle("execution", "wake", "wait.woken", 10_000, 3),
      Support.Fixtures.lifecycle("execution", "complete", "execution.completed", 12_000, 5),
    ]
    const durable = Support.Fixtures.fold(events)
    const live = Support.Fixtures.fold([events[3]!, events[0]!, events[2]!, events[1]!])

    expect(Support.UsageCost.activeTime(live, "thread")).toEqual(Support.UsageCost.activeTime(durable, "thread"))
    expect(Support.UsageCost.activeTime(live, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(7),
    })
  })

  it("reconstructs open work deterministically from duplicate and out-of-order delivery", () => {
    const started = Support.Fixtures.lifecycle("execution", "start", "execution.started", 5_000, 1)
    const waited = Support.Fixtures.lifecycle("execution", "wait", "wait.created", 10_000, 2)
    const resumed = Support.Fixtures.lifecycle("execution", "resume", "wait.woken", 12_000, 3)
    const snapshot = Support.Fixtures.fold([resumed, waited, started, resumed])

    expect(Support.UsageCost.activeTime(snapshot, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(5),
      activeSince: 12_000,
    })
  })

  it("unions overlapping parent and child intervals instead of adding parallel work", () => {
    const snapshot = Support.Fixtures.fold([
      Support.Fixtures.lifecycle("parent", "parent-start", "execution.started", 0, 1),
      Support.Fixtures.lifecycle("child", "child-start", "execution.started", 5_000, 1),
      Support.Fixtures.lifecycle("child", "child-complete", "execution.completed", 15_000, 2),
      Support.Fixtures.lifecycle("parent", "parent-wait", "wait.created", 10_000, 2),
    ])

    expect(Support.UsageCost.activeTime(snapshot, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(15),
    })
  })

  it("reports the same active time when a persisted fold is reopened and its events re-delivered", () => {
    const events = [
      Support.Fixtures.lifecycle("parent", "start", "execution.started", 1_000, 1),
      Support.Fixtures.lifecycle("parent", "wait", "wait.created", 11_000, 2),
    ]
    const beforeClose = Support.Fixtures.fold(events)
    const reopened = Support.UsageCost.deserialize(Support.UsageCost.serialize(beforeClose))!
    const afterRedelivery = Support.Fixtures.fold(events, { threadId: "thread", turnId: "turn" }, reopened)

    expect(Support.UsageCost.activeTime(afterRedelivery, "thread")).toEqual(
      Support.UsageCost.activeTime(beforeClose, "thread"),
    )
    expect(Support.UsageCost.activeTime(afterRedelivery, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(10),
    })
  })

  it("counts no time for an unstamped execution and keeps its costs", () => {
    const unstamped = Support.Fixtures.fold([
      Support.Fixtures.unstampedLifecycle("execution", "start", "execution.started", 1_000, 1),
      Support.Fixtures.unstampedLifecycle("execution", "complete", "execution.completed", 11_000, 2),
      Support.Fixtures.usage("cost", 0.25),
    ])
    const mixed = Support.Fixtures.fold([
      Support.Fixtures.unstampedLifecycle("execution", "start", "execution.started", 1_000, 1),
      Support.Fixtures.lifecycle("execution", "complete", "execution.completed", 11_000, 2),
    ])
    const withStamped = Support.Fixtures.fold(
      [
        Support.Fixtures.lifecycle("stamped", "start", "execution.started", 1_000, 1),
        Support.Fixtures.lifecycle("stamped", "complete", "execution.completed", 4_000, 2),
      ],
      { threadId: "thread", turnId: "turn" },
      unstamped,
    )

    expect(Support.UsageCost.activeTime(unstamped, "thread")).toEqual({ _tag: "Unavailable" })
    expect(Support.UsageCost.activeTime(mixed, "thread")).toEqual({ _tag: "Unavailable" })
    expect(Support.UsageCost.turnTotals(unstamped, "turn").costUsd).toBe(0.25)
    expect(Support.UsageCost.activeTime(withStamped, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(3),
    })
  })

  it("treats a regressing timestamp on a server-stamped execution as a defect", () => {
    const stamped = Support.Fixtures.fold([
      Support.Fixtures.lifecycle("execution", "start", "execution.started", 10_000, 1),
      Support.Fixtures.lifecycle("execution", "complete", "execution.completed", 1_000, 2),
    ])
    const withHealthy = Support.Fixtures.fold(
      [
        Support.Fixtures.lifecycle("healthy", "start", "execution.started", 1_000, 1),
        Support.Fixtures.lifecycle("healthy", "done", "execution.completed", 4_000, 2),
      ],
      { threadId: "thread", turnId: "turn" },
      stamped,
    )

    expect(Support.UsageCost.activeTime(stamped, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.zero,
      activeSince: 10_000,
    })
    expect(Support.UsageCost.activeTime(withHealthy, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(3),
      activeSince: 10_000,
    })
  })

  it("reads the mapped event stamp only and ignores a stamp carried in event data", () => {
    const dataStamped = Support.Fixtures.fold([
      {
        ...Support.Fixtures.unstampedLifecycle("execution", "start", "execution.started", 1_000, 1),
        data: { timestamp_source: "server" },
      },
      {
        ...Support.Fixtures.unstampedLifecycle("execution", "complete", "execution.completed", 11_000, 2),
        data: { timestamp_source: "server" },
      },
    ])

    expect(Support.UsageCost.activeTime(dataStamped, "thread")).toEqual({ _tag: "Unavailable" })
  })

  it("makes active time unavailable when lifecycle identity or timestamps are invalid", () => {
    const missingIdentity = Support.Fixtures.fold([
      { executionId: "", cursor: "start", sequence: 1, type: "execution.started", createdAt: 1 },
    ])
    const invalidTimestamp = Support.Fixtures.fold([
      Support.Fixtures.lifecycle("execution", "start", "execution.started", -1, 1),
    ])

    expect(Support.UsageCost.activeTime(missingIdentity, "thread")).toEqual({ _tag: "Unavailable" })
    expect(Support.UsageCost.activeTime(invalidTimestamp, "thread")).toEqual({ _tag: "Unavailable" })
  })

  it("uses durable sequence order and rejects regressing lifecycle timestamps", () => {
    const snapshot = Support.Fixtures.fold([
      Support.Fixtures.lifecycle("execution", "start", "execution.started", 10_000, 1),
      Support.Fixtures.lifecycle("execution", "wait", "wait.created", 5_000, 2),
    ])

    expect(Support.UsageCost.activeTime(snapshot, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.zero,
    })
  })
})
