import { TextAttributes } from "../src/presentation/markdown/styled-text"
import { expect, test } from "vitest"
import { buildTranscript } from "../src/opentui/rendering/opentui-renderer"
import { colors } from "../src/presentation/terminal/terminal-theme"
import { renderToolSummary } from "../src/presentation/tool/tool-summary"
import { expandableRowIds, transcriptUnits } from "../src/presentation/transcript/transcript-row"

import { toolFixtures, type ToolCall } from "./tool-presentation-support"
const { call, model, text, chunkFor, expectForeground, hasAttribute, shellPresentation, explore } = toolFixtures
test("styles tool actions as primary and paths and aggregate counts as muted", () => {
  const read = call("read", "read", { path: "src/a.ts" }, explore("read", "file"), { detail: "src/a.ts" })
  const edit = call(
    "edit",
    "edit",
    { path: "src/b.ts" },
    { family: "edit", action: "edit", activeLabel: "Editing", completeLabel: "Edited" },
    {
      files: [
        {
          key: "b",
          path: "src/b.ts",
          kind: "update",
          status: "complete",
          additions: 1,
          deletions: 0,
          patch: "",
          preview: false,
        },
      ],
    },
  )
  const shells = ["one", "two", "three"].map((command) =>
    call(`shell-${command}`, "bash", { command }, shellPresentation, { detail: command }),
  )
  const chunks = buildTranscript(model([read, edit, ...shells], ["tool:read"])).styled.chunks

  expectForeground(chunks, " Read", colors.text)
  expectForeground(chunks, " src/a.ts", colors.muted)
  expectForeground(chunks, " Edited", colors.text)
  expectForeground(chunks, " src/b.ts", colors.muted)
  expectForeground(chunks, " Ran", colors.text)
  expectForeground(chunks, " 3 commands", colors.muted)
})
test("omits folded continuation tools from transcript rows and navigation", () => {
  const continuation = {
    family: "direct" as const,
    action: "continuation",
    activeLabel: "Waiting",
    completeLabel: "Waited",
    rowDisplay: "continuation",
  } as ToolCall["presentation"]
  const value = model([
    call("shell", "bash", { command: "bun test" }, shellPresentation, { detail: "bun test" }),
    call("status", "shell_command_status", { processId: "1" }, continuation, { detail: "bun test" }),
    call("join", "await_subagents", {}, continuation),
  ])

  expect(transcriptUnits(value)).toMatchObject([{ kind: "tool", blocks: [0] }])
  expect(text(value)).toContain("$ bun test")
  expect(text(value)).not.toContain("Waited")
  expect(expandableRowIds(value)).not.toContain("tool:status")
  expect(expandableRowIds(value)).not.toContain("tool:join")
})
test("surfaces unowned continuation failures and folds process exits into their shell row", () => {
  const continuation = {
    family: "direct" as const,
    action: "continuation",
    activeLabel: "Waiting",
    completeLabel: "Waited",
    failedLabel: "Continuation failed",
    rowDisplay: "continuation",
  } as ToolCall["presentation"]
  const value = model([
    call("shell", "bash", { command: "bun test" }, shellPresentation, {
      detail: "bun test",
      status: "failed",
      process: { processId: "1", running: false, exitCode: 7 },
    }),
    call("join", "await_subagents", {}, continuation, {
      status: "failed",
      output: "Child report could not be collected",
    }),
    call("owned-status", "shell_command_status", { processId: "1" }, continuation, {
      status: "failed",
      output: "exit 7",
      parentId: "shell",
      process: { processId: "1", running: false, exitCode: 7 },
    }),
    call("orphan-status", "shell_command_status", { processId: "missing" }, continuation, {
      status: "failed",
      output: "Unknown process id: missing",
      process: { processId: "missing", running: false, exitCode: 7 },
    }),
  ])

  expect(transcriptUnits(value).map((unit) => unit.kind === "tool" && unit.blocks)).toEqual([[0], [1], [3]])
  expect(text(value)).toContain("Continuation failed")
  expect(text(value)).not.toContain("Waited")
  expect(expandableRowIds(value)).toContain("tool:join")
  expect(expandableRowIds(value)).toContain("tool:orphan-status")
  expect(expandableRowIds(value)).not.toContain("tool:owned-status")
})
test.each([
  ["running", "Oracle", " exploring"],
  ["complete", "Oracle", " has spoken"],
  ["running", "Librarian", " researching"],
  ["complete", "Librarian", " researched"],
  ["failed", "Oracle", " failed"],
  ["cancelled", "Oracle", " cancelled"],
  ["complete", "Subagent", " finished"],
  ["complete", "Reviewing", " code"],
  ["complete", "Custom Research Agent", " finished"],
] as const)("styles %s agent identity %s separately from lifecycle", (status, primary, secondary) => {
  let labels = {
    action: "custom",
    activeLabel: "Custom Research Agent working",
    completeLabel: "Custom Research Agent finished",
  }
  if (primary === "Reviewing")
    labels = { action: "review", activeLabel: "Reviewing code", completeLabel: "Reviewing code" }
  else if (primary === "Oracle")
    labels = { action: "oracle", activeLabel: "Oracle exploring", completeLabel: "Oracle has spoken" }
  else if (primary === "Librarian")
    labels = { action: "librarian", activeLabel: "Librarian researching", completeLabel: "Librarian researched" }
  else if (primary === "Subagent")
    labels = { action: "task", activeLabel: "Subagent working", completeLabel: "Subagent finished" }
  const agent = call("agent", "task", {}, { family: "agent", ...labels }, { status })
  const chunks = buildTranscript(model([agent])).styled.chunks

  expectForeground(chunks, ` ${primary}`, colors.text)
  expectForeground(chunks, secondary, colors.muted)
})
test("dims expanded agent prompts without losing markdown styles", () => {
  const parent = call(
    "parent",
    "task",
    {},
    { family: "agent", action: "task", activeLabel: "Subagent working", completeLabel: "Subagent finished" },
    { detail: "Top plain **top bold** *top italic* `top-code`" },
  )
  const child = call(
    "child",
    "task",
    {},
    { family: "agent", action: "task", activeLabel: "Subagent working", completeLabel: "Subagent finished" },
    { detail: "Nested plain" },
  )
  const chunks = buildTranscript({
    ...model([parent, child], ["tool:parent", "tool:child"]),
    items: [
      { _tag: "Block" as const, index: 0, id: "item:parent", turnId: "turn" },
      { _tag: "Block" as const, index: 1, id: "item:child", turnId: "child", parentId: "parent" },
    ],
  }).styled.chunks
  const plain = chunkFor(chunks, "Top plain")
  const bold = chunkFor(chunks, "top bold")
  const italic = chunkFor(chunks, "top italic")
  const code = chunkFor(chunks, "top-code")
  const nested = chunkFor(chunks, "Nested plain")

  for (const chunk of [plain, bold, italic, code, nested]) expect(hasAttribute(chunk, TextAttributes.DIM)).toBe(true)
  expect(hasAttribute(bold, TextAttributes.BOLD)).toBe(true)
  expect(hasAttribute(italic, TextAttributes.ITALIC)).toBe(true)
  expect(hasAttribute(code, TextAttributes.BOLD)).toBe(true)
  expect(code.fg !== undefined).toBe(true)
})
test("preserves primary and muted roles in nested agent tools", () => {
  const parent = call(
    "parent",
    "task",
    {},
    { family: "agent", action: "task", activeLabel: "Subagent working", completeLabel: "Subagent finished" },
  )
  const child = call("child", "read", { path: "src/nested path.ts" }, explore("read", "file"), {
    detail: "src/nested path.ts",
  })
  const value = {
    ...model([parent, child], ["tool:parent"]),
    items: [
      { _tag: "Block" as const, index: 0, id: "item:parent", turnId: "turn" },
      { _tag: "Block" as const, index: 1, id: "item:child", turnId: "child", parentId: "parent" },
    ],
  }
  const chunks = buildTranscript(value).styled.chunks

  expectForeground(chunks, "Read", colors.text)
  expectForeground(chunks, " src/nested path.ts", colors.muted)
})
test("preserves the Checked copy and semantic roles for expanded git status calls", () => {
  const gitStatus = call(
    "git-status",
    "git_status",
    {},
    { family: "explore", action: "git-status", activeLabel: "Checking", completeLabel: "Checked" },
    { detail: "working tree" },
  )
  const chunks = buildTranscript(model([gitStatus], ["tool:git-status"])).styled.chunks

  expectForeground(chunks, " Checked", colors.text)
  expectForeground(chunks, " working tree", colors.muted)
  expect(chunks.map((chunk) => chunk.text).join("")).not.toContain("Searched working tree")
})
test("keeps wrapped secondary summary text muted", () => {
  const lines = renderToolSummary({ primary: "Read", secondary: " src/a very long nested path.ts" }, { width: 10 })

  expect(lines.length).toBeGreaterThan(1)
  expect(lines.flat().find((chunk) => chunk.text === "Read")!.fg === colors.text).toBe(true)
  for (const chunk of lines.flat().filter((candidate) => candidate.text !== "Read"))
    expect(chunk.fg !== undefined).toBe(true)
})
test("keeps a selected agent row uniformly bold blue", () => {
  const agent = call(
    "agent",
    "oracle",
    {},
    { family: "agent", action: "oracle", activeLabel: "Oracle exploring", completeLabel: "Oracle has spoken" },
    { detail: "Review the code" },
  )
  const chunks = buildTranscript({ ...model([agent]), detailSelection: "tool:agent" }).styled.chunks
  const row = chunkFor(chunks, "Oracle has spoken")

  expect(hasAttribute(row, TextAttributes.BOLD)).toBe(true)
  expect(row.fg !== undefined).toBe(true)
})
test("keeps a completed Explore group successful while showing its failed tool", () => {
  const blocks = [
    call("read", "read", { path: "missing.ts" }, explore("read", "file"), {
      detail: "missing.ts",
      status: "failed",
      output: "File not found",
    }),
    call("search", "grep", { pattern: "owner" }, explore("grep", "search"), { detail: "owner" }),
  ]

  const rendered = text(model(blocks, ["tool:read"]))

  expect(rendered).toContain("✓ Explored 1 file, 1 search")
  expect(rendered).toContain("✕ Read missing.ts File not found")
})
test.each([
  ["all failed", ["failed", "failed"], "✕ Explored"],
  ["all cancelled", ["cancelled", "cancelled"], "⊘ Explored"],
  ["failed and cancelled", ["failed", "cancelled"], "✕ Explored"],
] as const)("shows an Explore group as terminal when %s", (_, statuses, expected) => {
  const blocks = statuses.map((status, index) =>
    call(`read-${index}`, "read", { path: `${index}.ts` }, explore("read", "file"), {
      detail: `${index}.ts`,
      status,
    }),
  )

  expect(text(model(blocks))).toContain(`${expected} 2 files`)
})
test("uses user-facing expanded labels for every exploration action", () => {
  const blocks = [
    call("read", "get_diagnostics", { path: "src/a.ts" }, explore("read", "file"), { detail: "src/a.ts" }),
    call("media", "view_media", { path: "image.png" }, explore("media", "media file"), {
      detail: "image.png",
    }),
    call("grep", "ripgrep", { query: "needle" }, explore("grep", "search"), { detail: "needle" }),
    call("search", "glob", { glob: "**/*.ts" }, explore("search", "search"), { detail: "**/*.ts" }),
    call("skill", "skill", { name: "tool-authoring" }, explore("skill", "skill"), {
      detail: "tool-authoring",
    }),
  ]
  const rendered = text(model(blocks, ["tool:read"]))

  expect(rendered).toContain("Read src/a.ts")
  expect(rendered).toContain("Viewed image.png")
  expect(rendered).toContain("Grep needle")
  expect(rendered).toContain("Searched **/*.ts")
  expect(rendered).toContain("tool-authoring")
  expect(rendered).not.toContain("Searched tool-authoring")
})
test("keeps source order while grouping only adjacent compatible families", () => {
  const blocks = [
    call("read", "read", { path: "a.ts" }, explore("read", "file")),
    call("search", "grep", { pattern: "x" }, explore("grep", "search")),
    call(
      "unknown",
      "mcp__server__lookup",
      { query: "x" },
      {
        family: "generic",
        action: "tool",
        activeLabel: "Running tool",
        completeLabel: "Ran tool",
      },
      { detail: "x" },
    ),
    call(
      "shell-one",
      "bash",
      { command: "one" },
      {
        family: "shell",
        action: "command",
        activeLabel: "Running",
        completeLabel: "Ran",
      },
    ),
    call(
      "shell-two",
      "bash",
      { command: "two" },
      {
        family: "shell",
        action: "command",
        activeLabel: "Running",
        completeLabel: "Ran",
      },
    ),
    call("read-two", "view_file", { path: "b.ts" }, explore("read", "file")),
  ]

  expect(transcriptUnits(model(blocks))).toMatchObject([
    { kind: "tool", group: "explore", blocks: [0, 1] },
    { kind: "tool", group: "other", blocks: [2] },
    { kind: "tool", group: "shell", blocks: [3, 4] },
    { kind: "tool", group: "explore", blocks: [5] },
  ])
  const rendered = text(model(blocks, ["tool:unknown", "tool:shell-one"]))
  expect(rendered).toContain("Ran tool x")
  expect(rendered).not.toContain("mcp__server__lookup")
  expect(rendered).toContain("Ran 2 commands")
})
test("shows failed details and bounds expanded tool and command output", () => {
  const output = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join("\n")
  const unknown = call(
    "unknown",
    "mcp__server__lookup",
    { query: "needle" },
    { family: "generic", action: "tool", activeLabel: "Running tool", completeLabel: "Ran tool" },
    { status: "failed", detail: "needle", output },
  )
  const shell = call(
    "shell",
    "bash",
    { command: "failing-command" },
    { family: "shell", action: "command", activeLabel: "Running", completeLabel: "Ran" },
    { status: "failed", detail: "failing-command", output, process: { exitCode: 23 } },
  )
  const rendered = text(model([unknown, shell], ["tool:unknown", "tool:shell"]))

  expect(rendered).toContain("✕ Ran tool needle")
  expect(rendered).toContain("$ failing-command (exit code: 23)")
  expect(rendered).toContain("line-12")
  expect(rendered).not.toContain("line-13")
})
test("highlights shell command syntax in transcript rows", () => {
  const command = 'git commit --amend -m "fix" && git push'
  const shell = call("shell", "bash", { command }, shellPresentation, { detail: command })
  const chunks = buildTranscript(model([shell])).styled.chunks
  expect(hasAttribute(chunkFor(chunks, "$ "), TextAttributes.DIM)).toBe(true)
  expect(hasAttribute(chunkFor(chunks, "git"), TextAttributes.BOLD)).toBe(true)
  expect(chunkFor(chunks, "--amend").fg !== undefined).toBe(true)
  expect(chunkFor(chunks, '"fix"').fg !== undefined).toBe(true)
  expect(hasAttribute(chunkFor(chunks, "&&"), TextAttributes.DIM)).toBe(true)
})
test("highlights each command of an expanded shell group", () => {
  const first = call("shell-one", "bash", { command: "git fetch origin main" }, shellPresentation, {
    detail: "git fetch origin main",
  })
  const second = call("shell-two", "bash", { command: "git push --force-with-lease" }, shellPresentation, {
    detail: "git push --force-with-lease",
  })
  const chunks = buildTranscript(model([first, second], ["tool:shell-one"])).styled.chunks
  const commands = chunks.filter((chunk) => chunk.text === "git")
  expect(commands).toHaveLength(2)
  for (const word of commands) expect(hasAttribute(word, TextAttributes.BOLD)).toBe(true)
  expect(chunkFor(chunks, "--force-with-lease").fg !== undefined).toBe(true)
})
test("keeps a selected shell row uniformly highlighted", () => {
  const shell = call("shell", "bash", { command: "git status --short" }, shellPresentation, {
    detail: "git status --short",
    output: "ok",
  })
  const chunks = buildTranscript({ ...model([shell]), detailSelection: "tool:shell" }).styled.chunks
  const row = chunkFor(chunks, "$ git status --short")
  expect(hasAttribute(row, TextAttributes.BOLD)).toBe(true)
  expect(row.fg !== undefined).toBe(true)
})
test("shows web research as inline status without displaying or expanding output", () => {
  const webSearch = call(
    "web-search",
    "web_search",
    { objective: "Find current documentation" },
    {
      family: "direct",
      action: "web-search",
      activeLabel: "Web Search",
      completeLabel: "Web Search",
      outputDisplay: "hidden",
    },
    { detail: "Find current documentation", output: "SEARCH RESULT BODY" },
  )
  const readPage = call(
    "read-page",
    "read_web_page",
    { url: "https://example.com" },
    {
      family: "direct",
      action: "read-web-page",
      activeLabel: "Read",
      completeLabel: "Read",
      outputDisplay: "hidden",
    },
    { detail: "https://example.com", output: "PAGE RESULT BODY" },
  )
  const value = model([webSearch, readPage], ["tool:web-search", "tool:read-page"])
  const rendered = text(value)

  expect(rendered).toContain("Web Search Find current documentation")
  expect(rendered).toContain("Read https://example.com")
  expect(rendered).not.toContain("SEARCH RESULT BODY")
  expect(rendered).not.toContain("PAGE RESULT BODY")
  expect(rendered).not.toContain("▸")
  expect(rendered).not.toContain("▾")
  expect(expandableRowIds(value)).toEqual([])
})
test("keeps running web output inline and out of navigation", () => {
  const status = "running"
  const webSearch = call(
    `web-${status}`,
    "web_search",
    { objective: "Find current documentation" },
    {
      family: "direct",
      action: "web-search",
      activeLabel: "Web Search",
      completeLabel: "Web Search",
      outputDisplay: "hidden",
    },
    { status, detail: "Find current documentation", output: "HIDDEN LIFECYCLE OUTPUT" },
  )
  const value = model([webSearch], [`tool:web-${status}`])
  const rendered = text(value)

  expect(rendered).toContain("Web Search Find current documentation")
  expect(rendered).not.toContain("HIDDEN LIFECYCLE OUTPUT")
  expect(rendered).not.toContain("▸")
  expect(rendered).not.toContain("▾")
  expect(expandableRowIds(value)).toEqual([])
})
test("shows recovery guidance when a hidden-output web tool fails", () => {
  const guidance =
    "Every selected web search provider is rate limited. The call did not change state. Next action: Retry later or use a different configured provider."
  const webSearch = call(
    "web-failed",
    "web_search",
    { objective: "Find current documentation" },
    {
      family: "direct",
      action: "web-search",
      activeLabel: "Web Search",
      completeLabel: "Web Search",
      outputDisplay: "hidden",
    },
    { status: "failed", detail: "Find current documentation", output: guidance },
  )
  const value = model([webSearch], ["tool:web-failed"])
  const rendered = text(value)

  expect(rendered.replace(/\n\s*/g, " ")).toContain(guidance)
  expect(rendered).toContain("▾")
  expect(expandableRowIds(value)).toEqual(["tool:web-failed"])
})
