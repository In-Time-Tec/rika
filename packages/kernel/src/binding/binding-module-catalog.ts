import type { HostBindingRegistry } from "@batonfx/repl"
import type { BindingRequirements, Options } from "./binding-requirements"
import * as ArtifactsBinding from "./artifacts-binding"
import * as ContextBinding from "./context-binding"
import * as EditsBinding from "./edits-binding"
import * as GoalBinding from "./goal-binding"
import * as HarnessBinding from "./harness-binding"
import * as McpBinding from "./mcp-binding"
import * as MediaBinding from "./media-binding"
import * as ProcessesBinding from "./processes-binding"
import * as ThreadsBinding from "./threads-binding"
import * as WebBinding from "./web-binding"
import * as WorkspaceBinding from "./workspace-binding"

/**
 * The mounted surface, in the order the bootstrap cell assembles it. Every name here becomes a
 * kernel global, so adding, removing, or renaming one changes `bindingsDigest` and starts a new
 * kernel epoch.
 */
export const make = (options: Options): ReadonlyArray<HostBindingRegistry.Module<BindingRequirements>> => [
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
