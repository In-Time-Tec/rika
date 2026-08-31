import type { Session } from "generalist"
import type { Store } from "generalist/instructions"
import type * as CodingToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import type * as ShellProcessRegistry from "@rika/coding-tools/shell-process-registry"
import type * as McpDiscovery from "@rika/extensions/mcp-discovery"
import type * as McpRuntime from "@rika/extensions/mcp-runtime"
import type * as ThreadQuery from "@rika/product/thread-query-service"
import type { GoalService } from "@rika/product/goal-service"
import type { ArtifactStore } from "./artifact/store"
import type { Requirements } from "./envelope"

/** Every service the mounted `rika.*` surface is closed over at registry construction. */
export type BindingRequirements =
  | CodingToolRuntime.Service
  | ShellProcessRegistry.Service
  | ThreadQuery.Factory
  | McpRuntime.McpRuntimeService
  | Store.Store
  | Session.SessionDirectory
  | GoalService
  | ArtifactStore
  | Requirements

/** What the host must decide before the surface can be mounted. */
export interface Options {
  readonly workspace: string
  readonly workspaceDigest: string
  readonly trustMode: string
  readonly servers: ReadonlyArray<McpDiscovery.ConfiguredServer>
}
