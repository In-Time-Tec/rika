import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import {
  childRunSpawnPermission,
  names,
  outputSchemas,
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
  it("resolves named narrowed Baton agents and Relay presets", () => {
    const registered = presets(model)
    expect(Object.keys(registered)).toEqual(names)
    for (const name of names) {
      const profile = resolve(name, model)
      expect(profile.agent.name).toBe(`rika-${name.toLowerCase()}`)
      expect(registered[name]?.model).toEqual(relayModel(model))
      expect(registered[name]?.tool_names).toEqual(Object.keys(profile.agent.toolkit.tools))
      expect(registered[name]?.permissions.length).toBeGreaterThan(0)
      expect(registered[name]?.output_schema_ref).toMatch(/^rika\.agent\./)
      if (name !== "Task") {
        expect(registered[name]?.tool_names).not.toContain("shell")
        expect(registered[name]?.tool_names).not.toContain("edit_file")
      }
    }
    expect(registered.Task?.tool_names).toContain("edit_file")
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

  it.effect("validates deterministic structured output contracts", () =>
    Effect.gen(function* () {
      expect(yield* Schema.decodeUnknownEffect(outputSchemas.Oracle)({ answer: "A", evidence: ["file:1"] })).toEqual({
        answer: "A",
        evidence: ["file:1"],
      })
      expect(
        yield* Schema.decodeUnknownEffect(outputSchemas.Painter)({
          text: "done",
          artifact: { path: "image.png", mimeType: "image/png", kind: "image" },
        }),
      ).toMatchObject({ artifact: { path: "image.png" } })
      const failure = yield* Effect.flip(
        Schema.decodeUnknownEffect(outputSchemas.Review)({ summary: "ok", findings: "invalid" }),
      )
      expect(String(failure)).toContain("findings")
    }),
  )

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
