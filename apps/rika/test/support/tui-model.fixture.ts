import { step, laneExecutionRoute, makeLaneModels } from "@rika/execution/test-harness"
import { TestModel } from "generalist/test"

type NativeToolName = "bash" | "edit" | "read" | "shell_command_status"
type NativeToolInput =
  | { readonly command: string; readonly timeout_ms?: number }
  | { readonly path: string; readonly read_range?: readonly [number, number] }
  | { readonly path: string; readonly old_str: string; readonly new_str: string; readonly replace_all?: boolean }
  | { readonly processId: string; readonly waitMillis?: number }

export const model = {
  ...step,
  tool: (name: NativeToolName, input: NativeToolInput, id: string) => TestModel.toolCall(name, input, { id }),
}

export { laneExecutionRoute, makeLaneModels }
export type { Lane, LaneModels, Part, Profile, ProviderHttpEnvelopeCounts, Step } from "@rika/execution/test-harness"
