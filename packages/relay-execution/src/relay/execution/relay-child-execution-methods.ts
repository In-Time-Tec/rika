import type { Tool } from "effect/unstable/ai"
import type { ChildExecutionMethodsInput } from "./relay-child-execution-context"
import { childInvocationMethods } from "./relay-child-invocation-methods"
import { fanOutMethods } from "./relay-child-fan-out-methods"
import { workflowMethods } from "./relay-workflow-methods"

export const childExecutionMethods = <AdditionalTools extends Record<string, Tool.Any>>(
  input: ChildExecutionMethodsInput<AdditionalTools>,
) => Object.assign(fanOutMethods(input), workflowMethods(input), childInvocationMethods(input))
