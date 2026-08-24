import { describe, expect, it } from "@effect/vitest"
import { TreeProjector } from "../../../src/projection/tree/projector"
import { resetEventPosition, treeEvent } from "../../support/projector-event.fixture"
import { Address, RunEvent } from "tenetkit/runtime"
import { Schema } from "effect"

const runFailure = (message: string) =>
  Schema.decodeSync(RunEvent.RunFailure)({ _tag: "tenetkit/runtime/AgentExecutionFailure", message })

describe("friendly failure presentation in the projector", () => {
  it("renders a model rate-limit failure as one what-happened message and an action", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-rate-limit", "say hello")
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "RunAccepted",
        messageId: "message-rate-limit",
        address: Address.make("agent:root"),
      }),
    )
    projector.apply(treeEvent("raw-root-run", { _tag: "RunAttemptStarted", attempt: 1 }))
    projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ModelCallFailed",
        deliveryId: "d1",
        turn: 0,
        modelCallId: "model-call:0:conversation",
        purpose: "conversation",
        attempts: 1,
        failedAt: 1,
        category: "rate-limit",
        classification: "terminal",
      }),
    )
    const unit = projector
      .snapshot()
      .units.find((candidate) => candidate.content._tag === "Block" && candidate.content.block._tag === "Error")
    expect(unit).toBeDefined()
    if (unit?.content._tag !== "Block" || unit.content.block._tag !== "Error") return
    expect(unit.content.block.title).toBe("The provider limited how often requests are accepted.")
    expect(unit.content.block.detail).toBe("")
    expect(unit.content.block.category).toBe("rate-limit")
    expect(unit.content.block.retryable).toBe(false)
  })

  it("settles a provider model failure as one error block carrying the run outcome", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-rate-limit-settled", "say hello")
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "RunAccepted",
        messageId: "message-rate-limit-settled",
        address: Address.make("agent:root"),
      }),
    )
    projector.apply(treeEvent("raw-root-run", { _tag: "RunAttemptStarted", attempt: 1 }))
    projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ModelCallFailed",
        deliveryId: "d1",
        turn: 0,
        modelCallId: "model-call:0:conversation",
        purpose: "conversation",
        attempts: 1,
        failedAt: 1,
        category: "rate-limit",
        classification: "terminal",
      }),
    )
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "RunFailed",
        error: runFailure("effect/ai/AiError/AiError: OpenAiClient.createResponseStream: Rate Limit exceeded"),
      }),
    )
    const errors = projector
      .snapshot()
      .units.filter((candidate) => candidate.content._tag === "Block" && candidate.content.block._tag === "Error")
    expect(errors).toHaveLength(1)
    const unit = errors[0]
    if (unit?.content._tag !== "Block" || unit.content.block._tag !== "Error") return
    expect(unit.content.block.title).toBe("The provider limited how often requests are accepted.")
    expect(unit.content.block.detail).toBe("")
    expect(unit.executionOutcome).toEqual({
      status: "failed",
      reason: "effect/ai/AiError/AiError: OpenAiClient.createResponseStream: Rate Limit exceeded",
    })
  })

  it("renders a raw provider failure with a cleaned detail", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-provider-error", "say hello")
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "RunAccepted",
        messageId: "message-provider-error",
        address: Address.make("agent:root"),
      }),
    )
    projector.apply(treeEvent("raw-root-run", { _tag: "RunAttemptStarted", attempt: 1 }))
    projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "RunFailed",
        error: runFailure("effect/ai/AiError/AiError: OpenAiClient.createResponseStream: Rate Limit exceeded"),
      }),
    )
    const unit = projector
      .snapshot()
      .units.find((candidate) => candidate.content._tag === "Block" && candidate.content.block._tag === "Error")
    expect(unit).toBeDefined()
    if (unit?.content._tag !== "Block" || unit.content.block._tag !== "Error") return
    expect(unit.content.block.detail).toBe("The provider rate-limited the request.")
  })
})
