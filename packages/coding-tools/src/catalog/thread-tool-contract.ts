import { Schema } from "effect"
import { Toolkit, Tool } from "effect/unstable/ai"
import * as Find from "./thread-tool-find-contract"
import * as Read from "./thread-tool-read-contract"

const ThreadState = Find.ThreadState
const findDefaultLimit = Find.findDefaultLimit
const findMaximumLimit = Find.findMaximumLimit
const previewDefaultLimit = Find.previewDefaultLimit
const previewMaximumLimit = Find.previewMaximumLimit
const FindThreadInput = Find.FindThreadInput
const FindThreadSuccess = Find.FindThreadSuccess
const ReadResult = Read.Result
const ReadToolError = Read.ToolError
const ReadToolFailure = Read.ToolFailure
const ReadThreadInput = Read.ReadThreadInput
const threadToolContractVersion = 2

const make = <Name extends string, Parameters extends Schema.Top, Success extends Schema.Top>(
  name: Name,
  description: string,
  parameters: Parameters,
  success: Success,
) => Tool.make(name, { description, parameters, success, failure: Read.ToolFailure, failureMode: "return" })
const searchThreadsTool = Tool.make("search_threads", {
  description: "Internal ReadThread agent tool. Find local Rika threads by bounded plain text and file: query terms.",
  parameters: Find.FindThreadInput,
  success: Read.Result,
  failure: Schema.Struct({ _tag: Schema.tag("ThreadToolError"), tool: Schema.String, message: Schema.String }),
  failureMode: "return",
})
const readThreadTranscriptTool = Tool.make("read_thread_transcript", {
  description:
    "Internal ReadThread agent tool. Read a bounded deterministic transcript for one local Rika thread by id",
  parameters: Read.ReadThreadInput,
  success: Read.Result,
  failure: Schema.Struct({ _tag: Schema.tag("ThreadToolError"), tool: Schema.String, message: Schema.String }),
  failureMode: "return",
})
const findThreadTool = make(
  "find_thread",
  "Find Rika threads by metadata without reading their transcript",
  Find.FindThreadInput,
  Find.FindThreadSuccess,
)
const toolkit = Toolkit.make(searchThreadsTool, readThreadTranscriptTool)
const findToolkit = Toolkit.make(findThreadTool)
const allToolkit = Toolkit.make(searchThreadsTool, readThreadTranscriptTool, findThreadTool)
const publicToolkit = Toolkit.make(findThreadTool)

export const ThreadContract = {
  threadToolContractVersion,
  ThreadState,
  findDefaultLimit,
  findMaximumLimit,
  previewDefaultLimit,
  previewMaximumLimit,
  FindThreadInput,
  FindThreadSuccess,
  ReadResult,
  ReadToolError,
  ReadToolFailure,
  ReadThreadInput,
  searchThreadsTool,
  readThreadTranscriptTool,
  findThreadTool,
  toolkit,
  findToolkit,
  publicToolkit,
  allToolkit,
}
