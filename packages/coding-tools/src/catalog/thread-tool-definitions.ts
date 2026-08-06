import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Find from "./thread-tool-find-contract"
import * as Read from "./thread-tool-read-contract"

const make = <Name extends string, Parameters extends Schema.Top, Success extends Schema.Top>(
  name: Name,
  description: string,
  parameters: Parameters,
  success: Success,
) => Tool.make(name, { description, parameters, success, failure: Read.ToolFailure, failureMode: "return" })
export const searchThreadsTool = Tool.make("search_threads", {
  description: "Internal ReadThread agent tool. Find local Rika threads by bounded plain text and file: query terms.",
  parameters: Find.FindThreadInput,
  success: Read.Result,
  failure: Schema.Struct({ _tag: Schema.tag("ThreadToolError"), tool: Schema.String, message: Schema.String }),
  failureMode: "return",
})
export const readThreadTranscriptTool = Tool.make("read_thread_transcript", {
  description:
    "Internal ReadThread agent tool. Read a bounded deterministic transcript for one local Rika thread by id",
  parameters: Read.ReadThreadInput,
  success: Read.Result,
  failure: Schema.Struct({ _tag: Schema.tag("ThreadToolError"), tool: Schema.String, message: Schema.String }),
  failureMode: "return",
})
export const findThreadTool = make(
  "find_thread",
  "Find Rika threads by metadata without reading their transcript",
  Find.FindThreadInput,
  Find.FindThreadSuccess,
)
