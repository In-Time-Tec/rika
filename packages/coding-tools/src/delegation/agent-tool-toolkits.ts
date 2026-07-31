import { Toolkit } from "effect/unstable/ai"
import * as Tools from "./agent-tool-tools"
import { awaitSubagentsTool } from "./agent-tool-selection"

export const modelToolkit = Toolkit.make(
  Tools.taskTool,
  Tools.oracleTool,
  Tools.librarianTool,
  Tools.reviewTool,
  Tools.surgeonTool,
  Tools.readThreadTool,
)

export const joinToolkit = Toolkit.make(awaitSubagentsTool)
