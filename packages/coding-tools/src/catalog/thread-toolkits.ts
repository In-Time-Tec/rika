import { Toolkit } from "effect/unstable/ai"
import * as Policy from "../policy/coding-tool-policy"
import type { Idempotency } from "../policy/policy-idempotency"
import * as Tools from "./thread-tool-definitions"

export const toolkit = Toolkit.make(Tools.searchThreadsTool, Tools.readThreadTranscriptTool)
export const findToolkit = Toolkit.make(Tools.findThreadTool)
export const coordinationToolkit = Toolkit.make(
  Tools.createThreadTool,
  Tools.threadInteractTool,
  Tools.waitForThreadsTool,
)
export const publicToolkit = Toolkit.make(
  Tools.findThreadTool,
  Tools.createThreadTool,
  Tools.threadInteractTool,
  Tools.waitForThreadsTool,
)
export const allToolkit = Toolkit.make(
  Tools.searchThreadsTool,
  Tools.readThreadTranscriptTool,
  Tools.findThreadTool,
  Tools.createThreadTool,
  Tools.threadInteractTool,
  Tools.waitForThreadsTool,
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
    Tools.searchThreadsTool,
    Policy.allow("safe", 10_000, 20_000, {
      family: "explore",
      action: "find-thread",
      activeLabel: "Exploring",
      completeLabel: "Explored",
      counter: "thread",
    }),
  ),
  Policy.register(
    Tools.readThreadTranscriptTool,
    Policy.allow("safe", 10_000, 40_000, {
      family: "direct",
      action: "read-thread",
      activeLabel: "Reading Thread",
      completeLabel: "Read Thread",
      counter: "thread",
    }),
  ),
  registration(Tools.findThreadTool, "safe", 10_000, 40_000, "find-thread", "Finding threads", "Found threads"),
  registration(Tools.createThreadTool, "unsafe", 30_000, 40_000, "create-thread", "Creating thread", "Created thread"),
  Policy.register(
    Tools.threadInteractTool,
    Policy.allow("unsafe", 30_000, 40_000, {
      family: "direct",
      action: "interact-thread",
      activeLabel: "Coordinating thread",
      completeLabel: "Coordinated thread",
      counter: "thread",
    }),
  ),
  registration(
    Tools.waitForThreadsTool,
    "safe",
    600_000,
    40_000,
    "wait-threads",
    "Waiting for threads",
    "Waited for threads",
  ),
]

export const waitHandlerOutputBudget = 36_000
