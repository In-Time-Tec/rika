import { describe, expect, it } from "@effect/vitest"
import { Result } from "effect"
import * as Support from "./usage-test-support"

describe("UsageCost", () => {
  it("counts a durable usage cursor only once across replay and live recovery", () => {
    const event = Support.Fixtures.usage("durable-usage", 2.5)
    const replayed = Support.UsageCost.observe(Support.UsageCost.empty, { threadId: "thread", turnId: "turn", event })
    const recovered = Support.UsageCost.observe(replayed, { threadId: "thread", turnId: "turn", event })

    expect(recovered).toBe(replayed)
    expect(Support.UsageCost.turnTotals(recovered, "turn").costUsd).toBe(2.5)
    expect(Support.UsageCost.threadTotals(recovered, "thread").costUsd).toBe(2.5)
    expect(recovered.global.costUsd).toBe(2.5)
  })

  it("totals input and output once while ignoring reasoning and input breakdowns", () => {
    const event = Support.Fixtures.reportedTokens("tokens", "gpt-5.6-sol", 30_000_000, 10_100_000, {
      input_tokens_uncached: 5_000_000,
      input_tokens_cache_read: 20_000_000,
      input_tokens_cache_write: 5_000_000,
      output_tokens_reasoning: 8_000_000,
    })
    const snapshot = Support.UsageCost.observe(Support.UsageCost.empty, { threadId: "thread", turnId: "turn", event })

    expect(Support.UsageCost.threadTotals(snapshot, "thread").tokens).toBe(40_100_000)
    expect(Support.UsageCost.threadTotals(snapshot, "thread").uncountedAttempts === 0).toBe(true)
  })

  it("keeps token and provider-cost completeness independent", () => {
    const completed = Support.Fixtures.reportedTokens("completed", "unknown", 10, 5, {
      input_tokens_uncached: null,
      cost: { amount: 2, currency: "USD" },
    })
    const snapshot = Support.UsageCost.observe(Support.UsageCost.empty, {
      threadId: "thread",
      turnId: "turn",
      event: completed,
    })

    expect(Support.UsageCost.threadTotals(snapshot, "thread").costUsd).toBe(2)
    expect(Support.UsageCost.threadTotals(snapshot, "thread").unpricedAttempts === 0).toBe(true)
    expect(Support.UsageCost.threadTotals(snapshot, "thread").tokens).toBe(15)
    expect(Support.UsageCost.threadTotals(snapshot, "thread").uncountedAttempts === 0).toBe(true)
  })

  it("marks tokens unavailable when the exact input total is missing", () => {
    const snapshot = Support.UsageCost.observe(Support.UsageCost.empty, {
      threadId: "thread",
      turnId: "turn",
      event: Support.Fixtures.reportedTokens("tokens", "gpt-5.6-sol", null, 5, {
        input_tokens_uncached: 10,
        input_tokens_cache_read: 20,
      }),
    })

    expect(Support.UsageCost.threadTotals(snapshot, "thread").uncountedAttempts === 0).toBe(false)
  })

  it("requires released identity and attempt fields only for cost-bearing events", () => {
    const unrelated = Support.UsageCost.observe(Support.UsageCost.empty, {
      threadId: "thread",
      turnId: "turn",
      event: { executionId: "execution", cursor: "output", sequence: 0, type: "workspace.diff", createdAt: 1 },
    })
    const missingIdentity = Support.RawUsageCost.observe(unrelated, {
      threadId: "thread",
      turnId: "turn",
      event: { ...Support.Fixtures.usage("missing-identity", 1), executionId: "" },
    })
    const missingAttempt = Support.UsageCost.observe(Support.UsageCost.empty, {
      threadId: "thread",
      turnId: "turn",
      event: { ...Support.Fixtures.usage("missing-attempt", 1), data: {} },
    })

    expect(unrelated).toBe(Support.UsageCost.empty)
    expect(Result.isFailure(missingIdentity) && missingIdentity.failure.reason).toBe("invalid-identity")
    expect(missingAttempt.global.unpricedAttempts === 0).toBe(false)
  })

  it("prices only from provider USD while counting the completed attempt usage", () => {
    const completed = Support.Fixtures.reportedTokens("completed", "gpt-5.6-sol", 10_000, 100, {
      input_tokens_uncached: 1_000,
      input_tokens_cache_read: 9_000,
      cost: { amount: 2.5, currency: "USD" },
    })
    const snapshot = Support.UsageCost.observe(Support.UsageCost.empty, {
      threadId: "thread",
      turnId: "turn",
      event: completed,
    })
    expect(snapshot.global.costUsd).toBe(2.5)
    expect(snapshot.global.tokens).toBe(10_100)
    expect(snapshot.global.unpricedAttempts === 0).toBe(true)
  })

  it("does not invent USD from usage tokens when provider cost is absent", () => {
    const report = Support.Fixtures.reportedTokens("report", "gpt-5.6-sol", 10_000, 100, {
      model_attempt_id: "attempt",
      model_call_id: "call",
      input_tokens_uncached: 1_000,
      input_tokens_cache_read: 9_000,
    })
    const snapshot = Support.UsageCost.observe(Support.UsageCost.empty, {
      threadId: "thread",
      turnId: "turn",
      event: report,
    })
    expect(snapshot.global.costUsd).toBe(0)
    expect(snapshot.global.tokens).toBe(10_100)
    expect(snapshot.global.pricedAttempts).toBe(0)
    expect(snapshot.global.unpricedAttempts).toBe(0)
  })

  it.each([
    ["non-USD", { amount: 2, currency: "EUR" }],
    ["malformed", { amount: "2", currency: "USD" }],
    ["negative", { amount: -2, currency: "USD" }],
  ])("makes cost unknown for present %s provider cost", (_, cost) => {
    const report = Support.Fixtures.reportedTokens("report", "gpt-5.6-sol", 1_000, 0, { model_attempt_id: "attempt" })
    const completed = {
      ...Support.Fixtures.usage("completed", 0),
      data: { ...Support.Fixtures.usage("completed", 0).data, model_attempt_id: "attempt", cost },
    }
    const estimated = Support.UsageCost.observe(Support.UsageCost.empty, {
      threadId: "thread",
      turnId: "turn",
      event: report,
    })
    const snapshot = Support.UsageCost.observe(estimated, { threadId: "thread", turnId: "turn", event: completed })

    expect(snapshot.global.costUsd).toBe(0)
    expect(snapshot.global.unpricedAttempts === 0).toBe(false)
  })

  it("leaves cost unpriced when attempt completion omits provider USD", () => {
    const report = Support.Fixtures.reportedTokens("report", "gpt-5.6-sol", 10_000, 100, {
      model_attempt_id: "attempt",
      input_tokens_uncached: 1_000,
      input_tokens_cache_read: 9_000,
    })
    const open = Support.UsageCost.observe(Support.UsageCost.empty, {
      threadId: "thread",
      turnId: "turn",
      event: report,
    })
    const settled = Support.UsageCost.observe(open, {
      threadId: "thread",
      turnId: "turn",
      event: Support.Fixtures.lifecycle("execution", "done", "execution.completed", 2, 9),
    })

    expect(open.global.costUsd).toBe(0)
    expect(open.global.tokens).toBe(10_100)
    expect(settled.global).toMatchObject({ costUsd: 0, tokens: 10_100, unpricedAttempts: 1 })
  })

  it("does not estimate nested completed usage and counts it unpriced once it settles", () => {
    const nested = {
      ...Support.Fixtures.usage("nested", 0),
      data: {
        model_call_id: "nested-call",
        model_attempt_id: "nested-attempt",
        attempt: 1,
        usage: { provider: "openai", model: "gpt-5.6-sol", input_tokens: 1_000, output_tokens: 0 },
      },
    }
    const announced = [Support.Fixtures.usage("priced", 1), nested].reduce(
      (current, event) => Support.UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      Support.UsageCost.empty,
    )
    const settled = Support.UsageCost.observe(announced, {
      threadId: "thread",
      turnId: "turn",
      event: Support.Fixtures.lifecycle("execution", "done", "execution.completed", 2, 9),
    })

    expect(announced.global).toMatchObject({ costUsd: 1, unpricedAttempts: 0 })
    expect(settled.global).toMatchObject({ costUsd: 1, unpricedAttempts: 1 })
  })

  it("keeps a thread total when another completed attempt has usage but no provider cost", () => {
    const priced = Support.UsageCost.observe(Support.UsageCost.empty, {
      threadId: "thread",
      turnId: "turn",
      event: Support.Fixtures.usage("first", 2),
    })
    const reported = Support.UsageCost.observe(priced, {
      threadId: "thread",
      turnId: "turn",
      event: Support.Fixtures.reportedTokens("second-usage", "gpt-5.6-sol", 100, 0, {
        input_tokens_uncached: 100,
      }),
    })

    expect(Support.UsageCost.threadTotals(reported, "thread").costUsd).toBe(2)
    expect(Support.UsageCost.threadTotals(reported, "thread").tokens).toBe(100)
    expect(Support.UsageCost.threadTotals(reported, "thread").unpricedAttempts).toBe(0)
  })

  it("counts an attempt as unpriced only once it settles without usage", () => {
    const awaiting = Support.UsageCost.observe(Support.UsageCost.empty, {
      threadId: "thread",
      turnId: "turn",
      event: Support.Fixtures.attemptCompleted("truncated", "attempt-truncated"),
    })
    const settled = Support.UsageCost.observe(awaiting, {
      threadId: "thread",
      turnId: "turn",
      event: Support.Fixtures.lifecycle("execution", "done", "execution.completed", 2, 9),
    })

    expect(Support.UsageCost.threadTotals(awaiting, "thread")).toMatchObject({
      costUsd: 0,
      unpricedAttempts: 0,
      uncountedAttempts: 1,
    })
    expect(Support.UsageCost.threadTotals(settled, "thread")).toMatchObject({
      costUsd: 0,
      unpricedAttempts: 1,
      uncountedAttempts: 1,
    })
  })

  it("keeps other threads and the global total priced when one thread has an unpriced attempt", () => {
    const priced = Support.UsageCost.observe(Support.UsageCost.empty, {
      threadId: "thread-b",
      turnId: "turn-b",
      event: { ...Support.Fixtures.usage("b", 3), executionId: "execution-b" },
    })
    const awaiting = Support.UsageCost.observe(priced, {
      threadId: "thread-a",
      turnId: "turn-a",
      event: Support.Fixtures.attemptCompleted("a", "attempt-a", "execution-a"),
    })
    const settled = Support.UsageCost.observe(awaiting, {
      threadId: "thread-a",
      turnId: "turn-a",
      event: Support.Fixtures.lifecycle("execution-a", "done", "execution.completed", 2, 9),
    })

    expect(Support.UsageCost.threadTotals(settled, "thread-a")).toMatchObject({ costUsd: 0, unpricedAttempts: 1 })
    expect(Support.UsageCost.threadTotals(settled, "thread-b")).toMatchObject({ costUsd: 3, unpricedAttempts: 0 })
    expect(settled.global).toMatchObject({ costUsd: 3, unpricedAttempts: 1 })
  })

  it("prices a retry that follows a truncated attempt", () => {
    const failed = [
      Support.Fixtures.attemptCompleted("truncated", "attempt-1"),
      { ...Support.Fixtures.attemptCompleted("truncated-failed", "attempt-1"), type: "model.attempt.failed" },
    ].reduce(
      (current, event) => Support.UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      Support.UsageCost.empty,
    )
    const retried = Support.UsageCost.observe(failed, {
      threadId: "thread",
      turnId: "turn",
      event: {
        ...Support.Fixtures.usage("retry", 1.75),
        data: { ...Support.Fixtures.usage("retry", 1.75).data, model_attempt_id: "attempt-2" },
      },
    })

    expect(Support.UsageCost.threadTotals(failed, "thread")).toMatchObject({ costUsd: 0, unpricedAttempts: 1 })
    expect(Support.UsageCost.threadTotals(retried, "thread")).toMatchObject({ costUsd: 1.75, unpricedAttempts: 1 })
  })

  it("deduplicates values by attempt and deliveries by opaque event cursor", () => {
    const first = Support.Fixtures.usage("first", 1)
    const sameAttempt = {
      ...Support.Fixtures.usage("second", 9),
      data: { ...Support.Fixtures.usage("second", 9).data, model_attempt_id: first.data?.model_attempt_id },
    }
    const duplicateDelivery = { ...Support.Fixtures.usage("ignored", 8), cursor: first.cursor }
    const snapshot = [first, sameAttempt].reduce(
      (current, event) => Support.UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      Support.UsageCost.empty,
    )
    const duplicate = Support.RawUsageCost.observe(snapshot, {
      threadId: "thread",
      turnId: "turn",
      event: duplicateDelivery,
    })

    expect(snapshot.global.costUsd).toBe(0)
    expect(snapshot.global.unpricedAttempts === 0).toBe(false)
    expect(Result.isFailure(duplicate) && duplicate.failure.reason).toBe("cursor-conflict")
  })

  it("scopes reused attempt ids to their execution", () => {
    const sharedAttempt = (cursor: string, executionId: string, costUsd: number) => ({
      ...Support.Fixtures.usage(cursor, costUsd),
      executionId,
      data: { ...Support.Fixtures.usage(cursor, costUsd).data, model_attempt_id: "attempt-shared" },
    })
    const first = sharedAttempt("cursor-a", "execution-a", 1)
    const second = sharedAttempt("cursor-b", "execution-b", 2)
    const snapshot = [first, second].reduce(
      (current, event) => Support.UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      Support.UsageCost.empty,
    )

    expect(snapshot.global.costUsd).toBe(3)
  })
})
