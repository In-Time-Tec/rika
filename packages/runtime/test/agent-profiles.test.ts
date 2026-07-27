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
    expect(mainInstructions).toContain("Route delegation by purpose")
    expect(mainInstructions).toContain("Call the read_thread subagent selectively")
    for (const name of names) {
      const profile = resolve(name, model)
      expect(profile.preset.instructions.length).toBeGreaterThan(0)
      expect(profile.preset.instructions).toContain(
        name === "ReadThread" ? "Check later Turns" : "read_thread subagent selectively",
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
      expect(profile.agent.policy).not.toBe(TurnPolicy.forever)
      expect(registered[name]?.model).toEqual(relayModel(model))
      expect(registered[name]?.tool_names).toEqual(Object.keys(profile.agent.toolkit.tools))
      expect(registered[name]?.permissions.length).toBeGreaterThan(0)
      expect(registered[name]).not.toHaveProperty("output_schema_ref")
    }
    expect(registered.Oracle).toMatchObject({
      tool_names: ["grep", "read", "web_search", "read_thread", ...threadRecoveryTools],
      permissions: ["workspace.read", "network.read", "thread.read"],
    })
    const expectedCaps = {
      Oracle: 60,
      Librarian: 30,
      Painter: 30,
      Review: 60,
      ReadThread: 30,
      Surgeon: 80,
      Task: 80,
    }
    for (const name of names) {
      expect(registered[name]?.max_tool_turns).toBe(expectedCaps[name])
    }
    expect(registered.Oracle?.instructions).toContain(
      "high-level planning, architecture tradeoffs, difficult debugging analysis",
    )
    expect(registered.Oracle?.instructions).toContain("Do not perform primary workspace or codebase exploration")
    expect(registered.Oracle?.instructions).toContain("do not modify files")
    expect(mainInstructions).toContain(
      "Use Task for workspace investigation, codebase exploration, reproductions, and implementation",
    )
    expect(mainInstructions).toContain(
      "delegate independent investigations in parallel only when they are genuinely independent",
    )
    expect(mainInstructions).toContain("Use Oracle only as a read-only, high-reasoning advisor")
    expect(mainInstructions).toContain("after it has been gathered")
    expect(mainInstructions).toContain("do not use Oracle to search or explore the codebase")
    expect(mainInstructions).not.toContain("Consult Oracle frequently")
    expect(mainInstructions).toContain("Use Review for a focused assessment")
    expect(mainInstructions).toContain("tell the user that you are consulting it")
    expect(mainInstructions).toContain("after consulting Oracle, state that you did")
    expect(mainInstructions).toContain("remaining responsible for the implementation and conclusion")
    expect(mainInstructions).toContain("Use read_web_page directly for a known safe public URL")
    expect(mainInstructions).toContain("web_search directly only for a one-shot fact or narrow lookup")
    expect(mainInstructions).toContain("Delegate substantive external research")
    expect(mainInstructions).toContain("Keep local workspace exploration with Task or workspace tools")
    expect(mainInstructions).toContain("Use auto for normal lookups")
    expect(mainInstructions).toContain("compare only when public claims are disputed")
    expect(mainInstructions).toContain("kind code for public semantic implementation examples through Exa Code Context")
    expect(mainInstructions).toContain(
      "kind github with githubSearchType for private or access-controlled codebases and exact code",
    )
    expect(mainInstructions).toContain("through the configured GitHub search provider")
    expect(mainInstructions).toContain("Prefer repository-qualified GitHub queries for access-controlled material")
    expect(mainInstructions).toContain("Do not use compare with private or access-controlled material")
    expect(mainInstructions).toContain("rather than reformulating sensitive terms through code, web, or read_web_page")
    expect(mainInstructions).toContain("For public research when Exa Code Context or GitHub search is unavailable")
    expect(mainInstructions).toContain("fetch authoritative public pages")
    expect(mainInstructions).not.toContain("Use subagents for independent work")
    expect(mainInstructions).not.toContain("parallel delegation")
    expect(mainInstructions).not.toContain("same tool-call batch")
    expect(registered.Librarian).toMatchObject({
      tool_names: [
        "web_search",
        "read_web_page",
        "task",
        "oracle",
        "librarian",
        "review",
        "surgeon",
        "read_thread",
        ...threadRecoveryTools,
      ],
      permissions: ["network.read", "thread.read"],
    })
    expect(registered.Librarian?.instructions).toContain("one to three focused queries")
    expect(registered.Librarian?.instructions).toContain("Use compare only for public")
    expect(registered.Librarian?.instructions).toContain(
      "kind code through Exa Code Context for public semantic implementation examples",
    )
    expect(registered.Librarian?.instructions).toContain(
      "kind github with githubSearchType for private or access-controlled codebases",
    )
    expect(registered.Librarian?.instructions).toContain("through the configured GitHub search provider")
    expect(registered.Librarian?.instructions).toContain(
      "Prefer repository-qualified GitHub queries for access-controlled material",
    )
    expect(registered.Librarian?.instructions).toContain("Do not use compare, code, web, or read_web_page")
    expect(registered.Librarian?.instructions).toContain("use a Task to inspect an available local checkout")
    expect(registered.Librarian?.instructions).toContain(
      "For public material, if Exa Code Context or GitHub search is unavailable",
    )
    expect(registered.Librarian?.instructions).not.toContain("A github kind selects")
    expect(registered.Librarian?.instructions).toContain("Search excerpts are leads, not final proof")
    expect(registered.Librarian?.instructions).toContain("distinguish sourced facts from your conclusions")
    expect(registered.Librarian?.instructions).toContain("Stop when the evidence is sufficient")
    expect(registered.Review).toMatchObject({
      tool_names: ["grep", "read", "web_search", "read_thread", ...threadRecoveryTools],
      permissions: ["workspace.read", "network.read", "thread.read"],
    })
    expect(registered.Oracle?.tool_names).not.toContain("task")
    expect(registered.Task?.instructions).toContain(
      "workspace investigation, reproduction, verification, or implementation",
    )
    expect(registered.Task?.instructions).toContain("Modify files only when the delegated task requests it")
    expect(registered.Task?.instructions).toContain(
      "For external research beyond a narrow lookup, delegate it to Librarian",
    )
    expect(registered.Task?.instructions).toContain("private or access-controlled codebases")
    expect(registered.Task?.instructions).toContain(
      "Prefer repository-qualified GitHub queries for access-controlled material",
    )
    expect(registered.Task?.instructions).toContain("Do not use compare, code, web, or read_web_page")
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
        "surgeon",
        "read_thread",
        ...threadRecoveryTools,
      ],
      permissions: ["workspace.read", "workspace.write", "process.run", "network.read", "thread.read"],
    })
    expect(registered.Task?.instructions).not.toContain("Use subagents for independent work")
    expect(registered.Task?.instructions).not.toContain("parallel delegation")
    expect(registered.Task?.instructions).not.toContain("same tool-call batch")
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

  it("routes Task and Surgeon to main and every read-only specialist to oracle", () => {
    const oracleModel = { provider: "oracle", model: "reasoning" }

    for (const registered of [presets({ model, oracleModel })]) {
      expect(Object.keys(registered)).toEqual(names)
      expect(registered.Oracle?.model).toEqual(relayModel(oracleModel))
      expect(registered.Task?.model).toEqual(relayModel(model))
      expect(registered.Librarian?.model).toEqual(relayModel(oracleModel))
      expect(registered.Painter?.model).toEqual(relayModel(oracleModel))
      expect(registered.Review?.model).toEqual(relayModel(oracleModel))
      expect(registered.ReadThread?.model).toEqual(relayModel(oracleModel))
      expect(registered.Surgeon?.model).toEqual(relayModel(model))
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
      "surgeon",
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
        "surgeon",
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

it("routes a specialist to its configured agent model instead of oracle", () => {
  const oracleModel = { provider: "oracle", model: "reasoning" }
  const librarianModel = { provider: "gate", model: "claude-sonnet-5", registrationKey: "sonnet-high" }

  const registered = presets({ model, oracleModel, agentModels: { Librarian: librarianModel } })

  expect(registered.Librarian?.model).toEqual(relayModel(librarianModel))
  expect(registered.Painter?.model).toEqual(relayModel(oracleModel))
  expect(registered.Task?.model).toEqual(relayModel(model))
})

it("keeps main and oracle routing when no agent models are supplied", () => {
  const oracleModel = { provider: "oracle", model: "reasoning" }

  const registered = presets({ model, oracleModel, agentModels: undefined })

  expect(registered.Task?.model).toEqual(relayModel(model))
  expect(registered.Librarian?.model).toEqual(relayModel(oracleModel))
})
