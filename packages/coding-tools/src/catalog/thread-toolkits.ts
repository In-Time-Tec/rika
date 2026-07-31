import { Toolkit } from "effect/unstable/ai"
import * as Policy from "../policy/coding-tool-policy"
import type { Idempotency } from "../policy/policy-idempotency"
import { ThreadContract } from "./thread-tool-contract"

export const toolkit = Toolkit.make(ThreadContract.searchThreadsTool, ThreadContract.readThreadTranscriptTool)
export const findToolkit = Toolkit.make(ThreadContract.findThreadTool)
export const coordinationToolkit = Toolkit.make(
  ThreadContract.createThreadTool,
  ThreadContract.threadInteractTool,
  ThreadContract.waitForThreadsTool,
)
export const publicToolkit = Toolkit.make(
  ThreadContract.findThreadTool,
  ThreadContract.createThreadTool,
  ThreadContract.threadInteractTool,
  ThreadContract.waitForThreadsTool,
)
export const allToolkit = Toolkit.make(
  ThreadContract.searchThreadsTool,
  ThreadContract.readThreadTranscriptTool,
  ThreadContract.findThreadTool,
  ThreadContract.createThreadTool,
  ThreadContract.threadInteractTool,
  ThreadContract.waitForThreadsTool,
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
  registration(
    ThreadContract.createThreadTool,
    "unsafe",
    30_000,
    40_000,
    "create-thread",
    "Creating thread",
    "Created thread",
  ),
  Policy.register(
    ThreadContract.threadInteractTool,
    Policy.allow("unsafe", 30_000, 40_000, {
      family: "direct",
      action: "interact-thread",
      activeLabel: "Coordinating thread",
      completeLabel: "Coordinated thread",
      counter: "thread",
    }),
  ),
  registration(
    ThreadContract.waitForThreadsTool,
    "safe",
    600_000,
    40_000,
    "wait-threads",
    "Waiting for threads",
    "Waited for threads",
  ),
]

export const waitHandlerOutputBudget = 36_000
