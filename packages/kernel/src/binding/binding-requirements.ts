import type { Session } from "@batonfx/core"
import type { HarnessStore } from "@batonfx/harness"
import type * as CodingToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import type * as ShellProcessRegistry from "@rika/coding-tools/shell-process-registry"
import type * as McpDiscovery from "@rika/extensions/mcp-discovery"
import type * as McpRuntime from "@rika/extensions/mcp-runtime"
import type * as ThreadQuery from "@rika/product/thread-query-service"
import type { GoalService } from "@rika/product/goal-service"
import type { AgentPort } from "./agent-port"
import type { ArtifactStore } from "./artifact-store"
import type { Requirements } from "./nested-operation-envelope"

/** Every service the mounted `rika.*` surface is closed over at registry construction. */
export type BindingRequirements =
  | CodingToolRuntime.Service
  | ShellProcessRegistry.Service
  | ThreadQuery.Factory
  | McpRuntime.McpRuntimeService
  | HarnessStore.HarnessStore
  | Session.SessionStore
  | GoalService
  | AgentPort
  | ArtifactStore
  | Requirements

/** What the host must decide before the surface can be mounted. */
export interface Options {
  readonly workspace: string
  readonly workspaceDigest: string
  readonly trustMode: string
  readonly servers: ReadonlyArray<McpDiscovery.ConfiguredServer>
}
