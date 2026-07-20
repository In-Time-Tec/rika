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
  it("resolves the exact narrowed tools and permissions for each shipping specialist", () => {
    const registered = presets(model)
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
      tool_names: ["find_files", "grep", "read", "web_search"],
      permissions: ["workspace.read", "network.read"],
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
    expect(registered.Librarian).toMatchObject({
      tool_names: ["web_search", "read_web_page", "task", "oracle", "librarian", "review"],
      permissions: ["network.read"],
    })
    expect(registered.Librarian?.instructions).toContain("one to three focused queries")
    expect(registered.Librarian?.instructions).toContain("Use compare only")
    expect(registered.Librarian?.instructions).not.toContain("provider IDs")
    expect(registered.Librarian?.instructions).toContain("Search excerpts are leads, not final proof")
    expect(registered.Librarian?.instructions).toContain("distinguish sourced facts from your conclusions")
    expect(registered.Librarian?.instructions).toContain("Stop when the evidence is sufficient")
    expect(registered.Review).toMatchObject({
      tool_names: ["grep", "read", "git_status", "web_search"],
      permissions: ["workspace.read", "network.read"],
    })
    expect(registered.Oracle?.tool_names).not.toContain("task")
    expect(registered.Task).toMatchObject({
      tool_names: [
        "find_files",
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
      ],
      permissions: ["workspace.read", "workspace.write", "process.run", "network.read"],
    })
  })

  it("supports data-first and data-last preset model overrides", () => {
    const oracleModel = { provider: "oracle", model: "reasoning" }
    const taskModel = { provider: "task", model: "coding" }
    const agentModels = { Task: taskModel }

    for (const registered of [presets(model, oracleModel, agentModels), presets(oracleModel, agentModels)(model)]) {
      expect(Object.keys(registered)).toEqual(names)
      expect(registered.Oracle?.model).toEqual(relayModel(oracleModel))
      expect(registered.Task?.model).toEqual(relayModel(taskModel))
      expect(registered.Review?.model).toEqual(relayModel(model))
    }

    expect(presets(model, oracleModel).Oracle?.model).toEqual(relayModel(oracleModel))
    expect(presets()(model).Oracle?.model).toEqual(relayModel(model))
  })

  it("maps subagent handoff targets to registered presets and excludes the media-gated Painter", () => {
    const registered = presets(model)
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
    expect(registered.ReadThread?.tool_names).toEqual([
      "find_thread",
      "read_thread",
      "task",
      "oracle",
      "librarian",
      "review",
    ])
    expect(registered.ReadThread?.permissions).toEqual(["thread.read"])
  })

  it.effect("uses the configured route for Painter and returns a typed unavailable error", () =>
    Effect.gen(function* () {
      const painter = yield* resolvePainter(model, true)
      expect(painter.preset.model).toEqual(relayModel(model))
      expect(painter.preset.tool_names).toEqual(["view_media", "task", "oracle", "librarian", "review"])
      const unavailable = yield* Effect.flip(resolvePainter(model, false))
      expect(unavailable._tag).toBe("PainterUnavailableError")
      expect(unavailable).toMatchObject(model)
    }),
  )
})
