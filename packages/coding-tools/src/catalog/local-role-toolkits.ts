import { Toolkit } from "effect/unstable/ai"
import * as Inputs from "../runtime/inputs"
import { ThreadContract } from "./thread-contract"

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
