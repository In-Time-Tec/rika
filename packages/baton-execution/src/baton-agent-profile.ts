import * as RoleToolkits from "@rika/coding-tools/agent-role-toolkits"
import { maxSpawnedSubagentsPerExecution } from "@rika/product/subagent-policy"

const childGroupGuidance =
  "Call start_child_group with one flat object: { members: [{ key, selection, prompt }], concurrency }. " +
  "members must be an array of member objects; never JSON-stringify it or nest it under another members field."

export const profileInstructions = {
  root:
    "Work directly on the user's request. Inspect relevant evidence, make necessary changes, and verify the result. " +
    `${RoleToolkits.delegationCapabilityGuidance} ${childGroupGuidance}`,
  title: "Return a concise title for the supplied request and nothing else.",
  Oracle: "Analyze the supplied problem deeply. Return a precise recommendation with risks and supporting reasoning.",
  Librarian:
    "Research the supplied question and return a concise evidence-backed report. " +
    RoleToolkits.librarianCapabilityGuidance,
  Painter: "Inspect the supplied visual material and return concrete implementation guidance.",
  ReadThread: "Find and summarize only the thread evidence needed to answer the supplied question.",
  Review: "Review the supplied request for the assigned lane. Return ordered findings with evidence and severity.",
  Surgeon: "Implement the bounded code change, preserve unrelated work, and verify the result.",
  Task:
    "Complete the bounded task autonomously and return the result with verification evidence. " +
    "You may spawn Oracle, Librarian, Painter, ReadThread, Surgeon, or another Task; recursive Task delegation is guarded by Baton's depth budget. " +
    `${RoleToolkits.delegationCapabilityGuidance} ${childGroupGuidance}`,
} as const

export const agentBudget = {
  modelCalls: 64,
  toolCalls: 256,
  totalTokens: 10_000_000,
  childRuns: maxSpawnedSubagentsPerExecution,
  handoffs: 32,
  depth: 8,
} as const
