import * as RuntimeContract from "@rika/coding-tools/coding-tool-runtime"
import * as RuntimeCoreTools from "../src/runtime/coding-tool-runtime-tool-definitions"
import * as RuntimeServiceTools from "../src/runtime/coding-tool-runtime-services"
import * as RuntimeTools from "../src/runtime/coding-tool-runtime-tools"
import * as AgentDefinitions from "../src/delegation/agent-tool-tools"
import * as AgentSelection from "../src/delegation/agent-tool-selection"
import * as AgentToolkits from "../src/delegation/agent-tool-toolkits"
import * as ThreadToolkits from "../src/catalog/thread-toolkits"
import * as ThreadFind from "../src/catalog/thread-tool-find-contract"
import * as ThreadCoordination from "../src/catalog/thread-tool-coordination-contract"
import * as AgentContract from "@rika/coding-tools/agent-tool-contract"
import * as ParallelSearchContract from "../src/web-research/parallel-search-contract"
import * as ProcessRegistry from "@rika/coding-tools/shell-process-registry"
import * as Runtime from "@rika/coding-tools/coding-tool-runtime"
import * as ToolInvocation from "@rika/coding-tools/tool-invocation"
export const contractFixtures = {
  RuntimeContract,
  RuntimeCoreTools,
  RuntimeServiceTools,
  RuntimeTools,
  AgentDefinitions,
  AgentSelection,
  AgentToolkits,
  ThreadToolkits,
  ThreadFind,
  ThreadCoordination,
  AgentContract,
  ParallelSearchContract,
  ProcessRegistry,
  Runtime,
  ToolInvocation,
}
