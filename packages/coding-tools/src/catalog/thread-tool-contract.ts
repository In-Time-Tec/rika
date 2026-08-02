import { Schema } from "effect"
import { Toolkit, Tool } from "effect/unstable/ai"
import { ToolInvocation } from "../catalog/tool-invocation"
import * as Find from "./thread-tool-find-contract"
import * as Read from "./thread-tool-read-contract"
import * as Coordination from "./thread-tool-coordination-contract"

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
const CreateThreadInput = Coordination.CreateThreadInput
const ThreadInteractAction = Coordination.ThreadInteractAction
const ThreadInteractInput = Coordination.ThreadInteractInput
const AcceptedSuccess = Coordination.AcceptedSuccess
const ThreadInteractSuccess = Coordination.ThreadInteractSuccess
const WaitForThreadsInput = Coordination.WaitForThreadsInput
const WaitForThreadsSuccess = Coordination.WaitForThreadsSuccess

const threadToolContractVersion = 2

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

const searchThreadsTool = Tool.make("search_threads", {
  description: "Internal ReadThread agent tool. Find local Rika threads by bounded plain text and file: query terms.",
  parameters: Find.FindThreadInput,
  success: Read.Result,
  failure: Schema.Struct({ _tag: Schema.tag("ThreadToolError"), tool: Schema.String, message: Schema.String }),
  failureMode: "return",
}).addDependency(ToolInvocation)
const readThreadTranscriptTool = Tool.make("read_thread_transcript", {
  description:
    "Internal ReadThread agent tool. Read a bounded deterministic transcript for one local Rika thread by id",
  parameters: Read.ReadThreadInput,
  success: Read.Result,
  failure: Schema.Struct({ _tag: Schema.tag("ThreadToolError"), tool: Schema.String, message: Schema.String }),
  failureMode: "return",
}).addDependency(ToolInvocation)
const findThreadTool = make(
  "find_thread",
  "Find Rika threads by metadata without reading their transcript",
  Find.FindThreadInput,
  Find.FindThreadSuccess,
).addDependency(ToolInvocation)
const createThreadTool = makeCoordination(
  "create_thread",
  "Create a coordinated Rika thread and accept its first turn",
  Coordination.CreateThreadInput,
  Coordination.AcceptedSuccess,
)
const threadInteractTool = makeCoordination(
  "thread_interact",
  "Inspect, message, or request control of an exact Rika thread",
  Coordination.ThreadInteractInput,
  Coordination.ThreadInteractSuccess,
)
const waitForThreadsTool = makeCoordination(
  "wait_for_threads",
  "Wait for one to ten exact thread turns and return every target status",
  Coordination.WaitForThreadsInput,
  Coordination.WaitForThreadsSuccess,
)
const toolkit = Toolkit.make(searchThreadsTool, readThreadTranscriptTool)
const findToolkit = Toolkit.make(findThreadTool)
const coordinationToolkit = Toolkit.make(createThreadTool, threadInteractTool, waitForThreadsTool)
const allToolkit = Toolkit.make(
  searchThreadsTool,
  readThreadTranscriptTool,
  findThreadTool,
  createThreadTool,
  threadInteractTool,
  waitForThreadsTool,
)
const publicToolkit = Toolkit.make(findThreadTool, createThreadTool, threadInteractTool, waitForThreadsTool)
const waitHandlerOutputBudget = 36_000

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
  CreateThreadInput,
  ThreadInteractAction,
  ThreadInteractInput,
  AcceptedSuccess,
  ThreadInteractSuccess,
  WaitForThreadsInput,
  WaitForThreadsSuccess,
  searchThreadsTool,
  readThreadTranscriptTool,
  findThreadTool,
  createThreadTool,
  threadInteractTool,
  waitForThreadsTool,
  toolkit,
  findToolkit,
  coordinationToolkit,
  publicToolkit,
  allToolkit,
  waitHandlerOutputBudget,
}
