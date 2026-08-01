import { Ids } from "@relayfx/sdk"
import { Function } from "effect"
import type { AgentProfile } from "@rika/product/execution-child-run"
import type { Execution } from "@relayfx/sdk"

export type ChildRunInputBase = Pick<Execution.SpawnChildRunInput, "child_execution_id" | "address_id" | "input">

type ChildRunDefinition =
  | { readonly _tag: "preset"; readonly presetName: AgentProfile }
  | {
      readonly _tag: "override"
      readonly definition: Pick<
        Execution.SpawnChildRunInput,
        | "instructions"
        | "model"
        | "compaction_policy"
        | "tool_names"
        | "permissions"
        | "workspace_policy"
        | "output_schema_ref"
        | "metadata"
      >
    }

export const buildChildRunInput: {
  (definition: ChildRunDefinition): (base: ChildRunInputBase) => ChildRunInputBase & Record<string, unknown>
  (base: ChildRunInputBase, definition: ChildRunDefinition): ChildRunInputBase & Record<string, unknown>
} = Function.dual(2, (base: ChildRunInputBase, definition: ChildRunDefinition) =>
  definition._tag === "preset"
    ? { ...base, preset_name: definition.presetName }
    : { ...base, ...definition.definition },
)

export const fanOutAgentId = (input: { readonly fanOutId: string; readonly childExecutionId: string }) =>
  Ids.AgentId.make(`agent:rika:fan-out:${input.fanOutId}:${input.childExecutionId}`)
