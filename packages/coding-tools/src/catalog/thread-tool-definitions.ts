import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { ToolInvocation } from "../catalog/tool-invocation"
import * as Find from "./thread-tool-find-contract"
import * as Read from "./thread-tool-read-contract"
import * as Coordination from "./thread-tool-coordination-contract"

const make = <Name extends string, Parameters extends Schema.Top, Success extends Schema.Top>(
  name: Name,
  description: string,
  parameters: Parameters,
  success: Success,
) => Tool.make(name, { description, parameters, success, failure: Read.ToolFailure, failureMode: "return" })
const makeCoordination = <Name extends string, Parameters extends Schema.Top, Success extends Schema.Top>(
  name: Name,
  description: string,
  parameters: Parameters,
  success: Success,
) => make(name, description, parameters, success).addDependency(ToolInvocation)

export const searchThreadsTool = Tool.make("search_threads", {
  description: "Internal ReadThread agent tool. Find local Rika threads by bounded plain text and file: query terms.",
  parameters: Find.FindThreadInput,
  success: Read.Result,
  failure: Schema.Struct({ _tag: Schema.tag("ThreadToolError"), tool: Schema.String, message: Schema.String }),
  failureMode: "return",
}).addDependency(ToolInvocation)
export const readThreadTranscriptTool = Tool.make("read_thread_transcript", {
  description:
    "Internal ReadThread agent tool. Read a bounded deterministic transcript for one local Rika thread by id",
  parameters: Read.ReadThreadInput,
  success: Read.Result,
  failure: Schema.Struct({ _tag: Schema.tag("ThreadToolError"), tool: Schema.String, message: Schema.String }),
  failureMode: "return",
}).addDependency(ToolInvocation)
export const findThreadTool = make(
  "find_thread",
  "Find Rika threads by metadata without reading their transcript",
  Find.FindThreadInput,
  Find.FindThreadSuccess,
).addDependency(ToolInvocation)
export const createThreadTool = makeCoordination(
  "create_thread",
  "Create a coordinated Rika thread and accept its first turn",
  Coordination.CreateThreadInput,
  Coordination.AcceptedSuccess,
)
export const threadInteractTool = makeCoordination(
  "thread_interact",
  "Inspect, message, or request control of an exact Rika thread",
  Coordination.ThreadInteractInput,
  Coordination.ThreadInteractSuccess,
)
export const waitForThreadsTool = makeCoordination(
  "wait_for_threads",
  "Wait for one to ten exact thread turns and return every target status",
  Coordination.WaitForThreadsInput,
  Coordination.WaitForThreadsSuccess,
)
