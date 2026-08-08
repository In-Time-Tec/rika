import { Toolkit } from "effect/unstable/ai"
import { ThreadContract } from "./thread-tool-contract"
import * as Inputs from "../runtime/coding-tool-runtime-inputs"

export const root = Toolkit.make(
  Inputs.Inputs.Grep.tool,
  Inputs.Inputs.Read.tool,
  Inputs.Inputs.Write.tool,
  Inputs.Inputs.Edit.tool,
  Inputs.Inputs.Bash.tool,
  Inputs.Inputs.ShellStatus.tool,
  Inputs.Inputs.WebSearch.tool,
  Inputs.Inputs.ReadPage.tool,
  Inputs.Inputs.Media.tool,
  ThreadContract.searchThreadsTool,
  ThreadContract.readThreadTranscriptTool,
)

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

export const surgeon = Toolkit.make(
  Inputs.Inputs.Grep.tool,
  Inputs.Inputs.Read.tool,
  Inputs.Inputs.Write.tool,
  Inputs.Inputs.Edit.tool,
  Inputs.Inputs.Bash.tool,
  Inputs.Inputs.ShellStatus.tool,
)

export const task = Toolkit.make(
  Inputs.Inputs.Grep.tool,
  Inputs.Inputs.Read.tool,
  Inputs.Inputs.Write.tool,
  Inputs.Inputs.Edit.tool,
  Inputs.Inputs.Bash.tool,
  Inputs.Inputs.ShellStatus.tool,
  Inputs.Inputs.WebSearch.tool,
  Inputs.Inputs.ReadPage.tool,
  Inputs.Inputs.Media.tool,
)
