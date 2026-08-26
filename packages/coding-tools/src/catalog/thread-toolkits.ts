import { Toolkit } from "effect/unstable/ai"
import * as Policy from "../policy/coding-tools"
import type { Idempotency } from "../policy/idempotency"
import { ThreadContract } from "./thread-contract"

export const toolkit = Toolkit.make(ThreadContract.searchThreadsTool, ThreadContract.readThreadTranscriptTool)
export const findToolkit = Toolkit.make(ThreadContract.findThreadTool)
export const publicToolkit = Toolkit.make(ThreadContract.findThreadTool)
export const allToolkit = Toolkit.make(
  ThreadContract.searchThreadsTool,
  ThreadContract.readThreadTranscriptTool,
  ThreadContract.findThreadTool,
)

const registration = (
  tool: Policy.RegisteredTool,
  idempotency: Idempotency,
  timeout: number,
  limit: number,
  action: string,
  activeLabel: string,
  completeLabel: string,
) =>
  Policy.register(
    tool,
    Policy.allow(idempotency, timeout, limit, {
      family: "direct",
      action,
      activeLabel,
      completeLabel,
      counter: "thread",
    }),
  )

export const registrations: ReadonlyArray<Policy.Registration> = [
  Policy.register(
    ThreadContract.searchThreadsTool,
    Policy.allow("safe", 10_000, 20_000, {
      family: "explore",
      action: "find-thread",
      activeLabel: "Exploring",
      completeLabel: "Explored",
      counter: "thread",
    }),
  ),
  Policy.register(
    ThreadContract.readThreadTranscriptTool,
    Policy.allow("safe", 10_000, 40_000, {
      family: "direct",
      action: "read-thread",
      activeLabel: "Reading Thread",
      completeLabel: "Read Thread",
      counter: "thread",
    }),
  ),
  registration(
    ThreadContract.findThreadTool,
    "safe",
    10_000,
    40_000,
    "find-thread",
    "Finding threads",
    "Found threads",
  ),
]
