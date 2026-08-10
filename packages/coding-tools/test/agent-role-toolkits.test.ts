import * as Toolkits from "@rika/coding-tools/agent-role-toolkits"
import { expect, test } from "vitest"

const names = (toolkit: { readonly tools: Readonly<Record<string, unknown>> }) => Object.keys(toolkit.tools).toSorted()

test("pins each product role to its minimum coding toolkit", () => {
  expect(names(Toolkits.root)).toEqual(
    [
      "bash",
      "edit",
      "grep",
      "read",
      "read_thread_transcript",
      "read_web_page",
      "search_threads",
      "shell_command_status",
      "view_media",
      "web_search",
      "write",
    ].toSorted(),
  )
  expect(names(Toolkits.oracle)).toEqual(
    ["grep", "read", "read_thread_transcript", "read_web_page", "search_threads", "web_search"].toSorted(),
  )
  expect(names(Toolkits.librarian)).toEqual(["read_web_page", "web_search"])
  expect(names(Toolkits.painter)).toEqual(["read", "view_media"])
  expect(names(Toolkits.readThread)).toEqual(["find_thread", "read_thread_transcript", "search_threads"])
  expect(names(Toolkits.surgeon)).toEqual(["bash", "edit", "grep", "read", "shell_command_status", "write"])
  expect(names(Toolkits.task)).toEqual([
    "bash",
    "edit",
    "grep",
    "read",
    "read_web_page",
    "shell_command_status",
    "view_media",
    "web_search",
    "write",
  ])
})

test("warns parents and web-only Librarians before local-path delegation", () => {
  expect(Toolkits.delegationCapabilityGuidance).toContain("Before spawning a child")
  expect(Toolkits.delegationCapabilityGuidance).toContain("Librarian is web-only")
  expect(Toolkits.delegationCapabilityGuidance).toContain("Refuse a mismatched Librarian spawn")
  expect(Toolkits.delegationCapabilityGuidance).toContain("Task or Oracle")
  expect(Toolkits.librarianCapabilityGuidance).toContain("file://")
  expect(Toolkits.librarianCapabilityGuidance).toContain("local-capable Task or Oracle")
})
