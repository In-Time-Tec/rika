import * as RoleToolkits from "@rika/coding-tools/agent-role-toolkits"

const childGroupGuidance =
  "Use run_child when later work depends on one child. For independent work, call run_child_group with one flat " +
  "object: { members: [{ key, selection, label?, prompt }], concurrency }. members must be an array of member " +
  "objects; never JSON-stringify it or nest it under another members field. Child results resume this same Run; " +
  "never poll for them or ask the user to continue."

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
    "You may delegate recursively while the model-visible child tools are available; Baton's pinned tree policy guards depth and direct-child admission. " +
    `${RoleToolkits.delegationCapabilityGuidance} ${childGroupGuidance}`,
} as const
