import { describe, expect, it } from "@effect/vitest"
import { TurnPolicy } from "@batonfx/core"
import { Effect } from "effect"
import {
  childRunSpawnPermission,
  mainInstructions,
  names,
  presets,
  resolve,
  resolvePainter,
  subagentHandoffTargets,
} from "../src/agent-profiles"

const model = { provider: "test", model: "deterministic" }
const threadRecoveryTools = ["search_threads", "read_thread_transcript"]
const expectedMainInstructions =
  "Oracle is a read-only, high-reasoning advisor for planning, reviewing, understanding code, and debugging. Consult Oracle frequently for complex or difficult tasks. Before consulting Oracle, tell the user that you are consulting it; after consulting Oracle, state that you did and use its advice while remaining responsible for the implementation and conclusion. Use web_search when the task depends on current external facts, documentation, or public code. Use auto for normal lookups and compare only when claims are disputed, recent, safety-sensitive, or high-impact. Use kind code for semantic implementation examples and kind github for exact code, repository metadata, issues, pull requests, or commits. Treat search snippets as discovery evidence: fetch authoritative pages when details matter, cite the URLs used, and state when sources disagree. Delegate broad or multi-source research to Librarian, but handle simple lookups directly and do not query every source by default. Use subagents for independent work when this improves speed or confidence. When the user gives a subagent count, honor that number; otherwise, when parallel delegation is useful, default to four useful subagents rather than forcing filler work. Start independent delegations in the same tool-call batch so they run in parallel."
const expectedInstructions = {
  Oracle:
    "Act as a read-only, high-reasoning technical advisor for planning, reviewing, understanding code, and debugging. Ground your advice in workspace evidence, explain your reasoning and recommendations, and do not modify files.",
  Librarian:
    "Research current external sources and return concise, cited findings without modifying files. Start with a self-contained objective and one to three focused queries. Use auto for a normal lookup. Use compare only for disputed, recent, safety-sensitive, or high-impact claims where independent perspectives improve confidence; do not query every source by default. Choose the search kind deliberately. Use web for general research, Exa through kind code for semantic implementation examples, and kind github with githubSearchType for exact code, repositories, issues and pull requests, or commit history. Prefer primary and authoritative sources. Search excerpts are leads, not final proof: use read_web_page when the source text, version, date, qualification, or surrounding context matters. Cross-check important claims, distinguish sourced facts from your conclusions, cite the URLs that support each material finding, and call out disagreement or uncertainty explicitly. Stop when the evidence is sufficient for the request.",
  Painter:
    "Produce a requested visual artifact through the available media route and report its metadata. Do not modify source files.",
  Review: "Review workspace changes for correctness, regressions, and missing tests. Do not modify files.",
  ReadThread: "Answer only from local thread transcripts and identify the threads used.",
  Task: "Complete the assigned implementation task in the workspace and report changed files and verification. Use subagents for independent work when this improves speed or confidence. When the user gives a subagent count, honor that number; otherwise, when parallel delegation is useful, default to four useful subagents rather than forcing filler work. Start independent delegations in the same tool-call batch so they run in parallel.",
} as const
const relayModel = (selection: {
  readonly provider: string
  readonly model: string
  readonly registrationKey?: string
}) => ({
  provider: selection.provider,
  model: selection.model,
  ...(selection.registrationKey === undefined ? {} : { registration_key: selection.registrationKey }),
})

describe("product agent profiles", () => {
  it("loads normalized instructions for every shipping profile", () => {
    expect(expectedMainInstructions.length).toBeGreaterThan(0)
    expect(Object.keys(expectedInstructions)).toEqual(names)
    expect(mainInstructions).toContain("Call the read_thread subagent selectively")
    for (const name of names) {
      const profile = resolve(name, model)
      expect(profile.preset.instructions.length).toBeGreaterThan(0)
      expect(profile.preset.instructions).toContain(
        name === "ReadThread" ? "checking later turns" : "read_thread subagent selectively",
      )
      expect(profile.agent.instructions).toBe(profile.preset.instructions)
    }
  })

  it("resolves the exact narrowed tools and permissions for each shipping specialist", () => {
    const registered = presets({ model })
    expect(Object.keys(registered)).toEqual(names)
    for (const name of names) {
      const profile = resolve(name, model)
      expect(profile.agent.name).toBe(`rika-${name.toLowerCase()}`)
      expect(profile.agent.policy).toBe(TurnPolicy.forever)
      expect(registered[name]?.model).toEqual(relayModel(model))
      expect(registered[name]?.tool_names).toEqual(Object.keys(profile.agent.toolkit.tools))
      expect(registered[name]?.permissions.length).toBeGreaterThan(0)
      expect(registered[name]).not.toHaveProperty("output_schema_ref")
    }
    expect(registered.Oracle).toMatchObject({
      tool_names: ["grep", "read", "web_search", "read_thread", ...threadRecoveryTools],
      permissions: ["workspace.read", "network.read", "thread.read"],
    })
    expect(registered.Oracle?.instructions).toContain("planning, reviewing, understanding code, and debugging")
    expect(registered.Oracle?.instructions).toContain("do not modify files")
    expect(mainInstructions).toContain("Consult Oracle frequently for complex or difficult tasks")
    expect(mainInstructions).toContain("tell the user that you are consulting it")
    expect(mainInstructions).toContain("after consulting Oracle, state that you did")
    expect(mainInstructions).toContain("remaining responsible for the implementation and conclusion")
    expect(mainInstructions).toContain("Use auto for normal lookups")
    expect(mainInstructions).toContain("kind code for semantic implementation examples")
    expect(mainInstructions).toContain("kind github for exact code")
    expect(mainInstructions).not.toContain("provider IDs")
    expect(mainInstructions).toContain("fetch authoritative pages")
    expect(mainInstructions).toContain("Delegate broad or multi-source research to Librarian")
    expect(mainInstructions).toContain("default to four useful subagents")
    expect(mainInstructions).toContain("honor that number")
    expect(mainInstructions).toContain("same tool-call batch")
    expect(registered.Librarian).toMatchObject({
      tool_names: [
        "web_search",
        "read_web_page",
        "task",
        "oracle",
        "librarian",
        "review",
        "read_thread",
        ...threadRecoveryTools,
      ],
      permissions: ["network.read", "thread.read"],
    })
    expect(registered.Librarian?.instructions).toContain("one to three focused queries")
    expect(registered.Librarian?.instructions).toContain("Use compare only")
    expect(registered.Librarian?.instructions).not.toContain("provider IDs")
    expect(registered.Librarian?.instructions).toContain("Search excerpts are leads, not final proof")
    expect(registered.Librarian?.instructions).toContain("distinguish sourced facts from your conclusions")
    expect(registered.Librarian?.instructions).toContain("Stop when the evidence is sufficient")
    expect(registered.Review).toMatchObject({
      tool_names: ["grep", "read", "web_search", "read_thread", ...threadRecoveryTools],
      permissions: ["workspace.read", "network.read", "thread.read"],
    })
    expect(registered.Oracle?.tool_names).not.toContain("task")
    expect(registered.Task).toMatchObject({
      tool_names: [
        "grep",
        "read",
        "write",
        "edit",
        "bash",
        "shell_command_status",
        "web_search",
        "task",
        "oracle",
        "librarian",
        "review",
        "read_thread",
        ...threadRecoveryTools,
      ],
      permissions: ["workspace.read", "workspace.write", "process.run", "network.read", "thread.read"],
    })
    expect(registered.Task?.instructions).toContain("default to four useful subagents")
    expect(registered.Task?.instructions).toContain("honor that number")
    expect(registered.Task?.instructions).toContain("same tool-call batch")
  })

  it("grants thread read permission to every profile that can recover thread context", () => {
    const registered = presets({ model })
    for (const profile of Object.values(registered)) {
      if (
        profile.tool_names.some(
          (tool) => tool === "read_thread" || tool === "search_threads" || tool === "read_thread_transcript",
        )
      )
        expect(profile.permissions).toContain("thread.read")
    }
  })

  it("routes Task to main and every specialist to oracle", () => {
    const oracleModel = { provider: "oracle", model: "reasoning" }

    for (const registered of [presets({ model, oracleModel })]) {
      expect(Object.keys(registered)).toEqual(names)
      expect(registered.Oracle?.model).toEqual(relayModel(oracleModel))
      expect(registered.Task?.model).toEqual(relayModel(model))
      expect(registered.Librarian?.model).toEqual(relayModel(oracleModel))
      expect(registered.Painter?.model).toEqual(relayModel(oracleModel))
      expect(registered.Review?.model).toEqual(relayModel(oracleModel))
      expect(registered.ReadThread?.model).toEqual(relayModel(oracleModel))
    }

    expect(presets({ model, oracleModel }).Oracle?.model).toEqual(relayModel(oracleModel))
    expect(presets({ model }).Oracle?.model).toEqual(relayModel(model))
  })

  it("maps subagent handoff targets to registered presets and excludes the media-gated Painter", () => {
    const registered = presets({ model })
    for (const target of subagentHandoffTargets) {
      expect(names).toContain(target.preset_name)
      expect(registered[target.preset_name]).toBeDefined()
    }
    expect(subagentHandoffTargets.map((target) => target.preset_name)).not.toContain("Painter")
    expect(subagentHandoffTargets.map((target) => target.name)).toEqual([
      "oracle",
      "librarian",
      "review",
      "read_thread",
      "task",
    ])
    expect(childRunSpawnPermission).toEqual({ name: "relay.child_run.spawn", value: true })
    expect(registered.ReadThread?.tool_names).toEqual(["search_threads", "read_thread_transcript"])
    expect(registered.ReadThread?.permissions).toEqual(["thread.read"])
  })

  it.effect("uses the configured route for Painter and returns a typed unavailable error", () =>
    Effect.gen(function* () {
      const painter = yield* resolvePainter(model, true)
      expect(painter.preset.model).toEqual(relayModel(model))
      expect(painter.preset.tool_names).toEqual([
        "view_media",
        "task",
        "oracle",
        "librarian",
        "review",
        "read_thread",
        ...threadRecoveryTools,
      ])
      expect(painter.preset.permissions).toEqual(["workspace.read", "thread.read"])
      const unavailable = yield* Effect.flip(resolvePainter(model, false))
      expect(unavailable._tag).toBe("PainterUnavailableError")
      expect(unavailable).toMatchObject(model)
    }),
  )
})
