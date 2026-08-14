import { Toolkit } from "effect/unstable/ai"
import * as Inputs from "../runtime/coding-tool-runtime-inputs"
import { ThreadContract } from "./thread-tool-contract"

export const oracle = Toolkit.make(
  Inputs.Inputs.Grep.tool,
  Inputs.Inputs.Read.tool,
  Inputs.Inputs.WebSearch.tool,
  Inputs.Inputs.ReadPage.tool,
  ThreadContract.searchThreadsTool,
  ThreadContract.readThreadTranscriptTool,
)

export const librarian = Toolkit.make(Inputs.Inputs.WebSearch.tool, Inputs.Inputs.ReadPage.tool)

export const painter = Toolkit.make(Inputs.Inputs.Read.tool, Inputs.Inputs.Media.tool)

export const readThread = Toolkit.make(
  ThreadContract.searchThreadsTool,
  ThreadContract.readThreadTranscriptTool,
  ThreadContract.findThreadTool,
)
