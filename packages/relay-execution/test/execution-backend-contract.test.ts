import { describe, expect, it } from "@effect/vitest"

import { Content, Ids } from "@relayfx/sdk"

import { fixture as testSupport } from "./execution-backend-fixture"
const { RelayExecutionBackend } = testSupport
describe("ExecutionBackend Relay client adapter", () => {
  it("keeps preset inheritance separate from explicit child-run overrides", () => {
    const base = {
      child_execution_id: Ids.ChildExecutionId.make("child:one"),
      address_id: Ids.AddressId.make("address:rika"),
      input: [Content.text("Explore the runtime")],
    }
    const inherited = RelayExecutionBackend.buildChildRunInput(base, {
      _tag: "preset",
      presetName: "Task",
    })
    const explicit = RelayExecutionBackend.buildChildRunInput(base, {
      _tag: "override",
      definition: {
        instructions: "Complete the task",
        model: { provider: "test", model: "gpt-5.6-luna", registration_key: "luna-low" },
        tool_names: ["read"],
        permissions: ["workspace.read"],
        output_schema_ref: "rika.agent.task.v1",
        metadata: { product_profile: "Task", rika_reasoning_effort: "low" },
      },
    })

    expect(inherited).toEqual({ ...base, preset_name: "Task" })
    expect(Object.keys(inherited).toSorted()).toEqual(["address_id", "child_execution_id", "input", "preset_name"])
    expect(explicit).toEqual({
      ...base,
      instructions: "Complete the task",
      model: { provider: "test", model: "gpt-5.6-luna", registration_key: "luna-low" },
      tool_names: ["read"],
      permissions: ["workspace.read"],
      output_schema_ref: "rika.agent.task.v1",
      metadata: { product_profile: "Task", rika_reasoning_effort: "low" },
    })
    expect(explicit).not.toHaveProperty("preset_name")
  })
})
