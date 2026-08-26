import { Toolkit } from "effect/unstable/ai"
import * as Grep from "../workspace/search/grep"
import * as List from "../workspace/search/list"
import * as Read from "../workspace/read"
import * as Write from "../workspace/write"
import * as Edit from "../workspace/edit"
import * as Bash from "../process/bash"
import * as ShellStatus from "../process/command-status"
import * as WebSearch from "../web-research/search/tool"
import * as ReadPage from "../web-research/read-page/tool"
import * as Media from "../media/tool"
import * as ToolPolicy from "../policy/coding-tools"
import * as CoreTools from "./tool-definitions"
import * as ServiceTools from "./services"

export const registrations: ReadonlyArray<ToolPolicy.Registration> = [
  Grep.registration,
  List.registration,
  Read.registration,
  Write.registration,
  Edit.registration,
  Bash.registration,
  ShellStatus.registration,
  WebSearch.registration,
  ReadPage.registration,
  Media.registration,
]
export const toolkit = Toolkit.make(
  CoreTools.grepTool,
  List.tool,
  CoreTools.readTool,
  CoreTools.writeTool,
  CoreTools.editTool,
  CoreTools.bashTool,
  ServiceTools.shellCommandStatusTool,
  ServiceTools.webSearchTool,
  ServiceTools.readWebPageTool,
  ServiceTools.viewMediaTool,
)
