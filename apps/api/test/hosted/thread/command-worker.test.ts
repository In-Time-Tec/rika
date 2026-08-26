import { describe, expect, it } from "vitest"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { commandControlFailure } from "../../../src/hosted/thread/command-worker"

const cancellationFailure: InteractiveEvent = {
  _tag: "ExecutionControlFailed",
  action: "cancel",
  failure: {
    tag: "CancelTurnFailure",
    category: "operation",
    message: "Cancellation backend unavailable",
    retryable: true,
    retry: "none",
    actor: "environment",
  },
}

describe("hosted Thread command control failures", () => {
  it("rejects a Cancel command when durable cancellation failed", () => {
    expect(commandControlFailure({ _tag: "Cancel" }, [cancellationFailure])).toEqual(cancellationFailure)
  })

  it("does not apply another control action's failure to a command", () => {
    expect(commandControlFailure({ _tag: "Approve" }, [cancellationFailure])).toBeUndefined()
    expect(commandControlFailure({ _tag: "Steer" }, [cancellationFailure])).toBeUndefined()
  })
})
