import { Toolkit } from "effect/unstable/ai"
import { ThreadContract } from "./thread-tool-contract"
import * as Inputs from "../runtime/coding-tool-runtime-inputs"

export const delegationCapabilityGuidance =
  "Before spawning a child, validate every path requirement in its prompt against the selected profile. " +
  "Librarian is web-only and cannot read workspace paths, relative or absolute local paths, or file:// URLs. " +
  "Refuse a mismatched Librarian spawn with an actionable warning, and select Task or Oracle for local-file work."

export const librarianCapabilityGuidance =
  "Your tools are web-only. If the request requires a workspace path, relative or absolute local path, or file:// URL, " +
  "refuse and tell the parent to use a local-capable Task or Oracle child."

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
