import { Toolkit } from "effect/unstable/ai"
import * as Grep from "../workspace/grep-files-tool"
import * as List from "../workspace/list-files-tool"
import * as Read from "../workspace/read-file-tool"
import * as Write from "../workspace/write-file-tool"
import * as Edit from "../workspace/edit-file-tool"
import * as Bash from "../process/bash-tool"
import * as ShellStatus from "../process/shell-command-status-tool"
import * as WebSearch from "../web-research/web-search-tool"
import * as ReadPage from "../web-research/read-web-page-tool"
import * as Media from "../media/view-media-tool"
import * as ToolPolicy from "../policy/coding-tool-policy"
import * as CoreTools from "./coding-tool-runtime-tool-definitions"
import * as ServiceTools from "./coding-tool-runtime-services"

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
