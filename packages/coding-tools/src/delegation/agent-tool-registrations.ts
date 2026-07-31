import * as Policy from "../policy/coding-tool-policy"
import * as Tools from "./agent-tool-tools"
import { awaitSubagentsTool } from "./agent-tool-selection"

export const registrations: ReadonlyArray<Policy.Registration> = [
  Policy.register(
    Tools.taskTool,
    Policy.allow("unsafe", 120_000, 40_000, {
      family: "agent",
      action: "task",
      activeLabel: "Subagent working",
      completeLabel: "Subagent finished",
    }),
  ),
  Policy.register(
    Tools.oracleTool,
    Policy.allow("unsafe", 120_000, 40_000, {
      family: "agent",
      action: "oracle",
      activeLabel: "Oracle exploring",
      completeLabel: "Oracle has spoken",
    }),
  ),
  Policy.register(
    Tools.librarianTool,
    Policy.allow("unsafe", 120_000, 40_000, {
      family: "agent",
      action: "librarian",
      activeLabel: "Librarian researching",
      completeLabel: "Librarian researched",
    }),
  ),
  Policy.register(
    Tools.reviewTool,
    Policy.allow("unsafe", 120_000, 40_000, {
      family: "agent",
      action: "review",
      activeLabel: "Reviewing code",
      completeLabel: "Reviewed code",
      counter: "review",
    }),
  ),
  Policy.register(
    Tools.surgeonTool,
    Policy.allow("unsafe", 120_000, 40_000, {
      family: "agent",
      action: "surgeon",
      activeLabel: "Surgeon operating",
      completeLabel: "Surgeon closed up",
    }),
  ),
  Policy.register(
    Tools.readThreadTool,
    Policy.allow("unsafe", 120_000, 40_000, {
      family: "agent",
      action: "read-thread",
      activeLabel: "Reading Thread",
      completeLabel: "Read Thread",
      counter: "thread",
    }),
  ),
  Policy.register(
    awaitSubagentsTool,
    Policy.allow("unsafe", 120_000, 40_000, {
      family: "direct",
      action: "await-subagents",
      activeLabel: "Waiting for subagents",
      completeLabel: "Collected subagents",
      failedLabel: "Subagent wait failed",
      rowDisplay: "continuation",
    }),
  ),
]
