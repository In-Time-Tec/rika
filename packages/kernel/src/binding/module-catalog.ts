import type { HostBindings } from "generalist/repl"
import type { BindingRequirements, Options } from "./requirements"
import * as ArtifactsBinding from "./artifact/capability"
import * as ContextBinding from "./capability/context"
import * as EditsBinding from "./capability/edits"
import * as GoalBinding from "./capability/goal"
import * as HarnessBinding from "./capability/harness"
import * as McpBinding from "./capability/mcp"
import * as MediaBinding from "./capability/media"
import * as ProcessesBinding from "./capability/processes"
import * as ThreadsBinding from "./capability/threads"
import * as WebBinding from "./capability/web"
import * as WorkspaceBinding from "./capability/workspace"

/**
 * The mounted surface, in the order the bootstrap cell assembles it. Every name here becomes a
 * kernel global, so adding, removing, or renaming one changes `bindingsDigest` and starts a new
 * kernel epoch.
 */
export const make = (options: Options): ReadonlyArray<HostBindings.Module<BindingRequirements>> => [
  WorkspaceBinding.module,
  EditsBinding.module,
  ProcessesBinding.module,
  WebBinding.module,
  MediaBinding.module,
  ThreadsBinding.make(options.workspace),
  ContextBinding.make({ workspace: options.workspace, trustMode: options.trustMode }),
  HarnessBinding.make({ workspaceDigest: options.workspaceDigest }),
  GoalBinding.module,
  McpBinding.make(options.servers),
  ArtifactsBinding.module,
]

export const moduleNames: ReadonlyArray<string> = [
  WorkspaceBinding.name,
  EditsBinding.name,
  ProcessesBinding.name,
  WebBinding.name,
  MediaBinding.name,
  ThreadsBinding.name,
  ContextBinding.name,
  HarnessBinding.name,
  GoalBinding.name,
  McpBinding.name,
  ArtifactsBinding.name,
]
