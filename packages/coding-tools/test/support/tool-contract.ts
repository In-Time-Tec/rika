import * as RuntimeContract from "@rika/coding-tools/coding-tool-runtime"
import * as RuntimeCoreTools from "../../src/runtime/tool-definitions"
import * as RuntimeServiceTools from "../../src/runtime/services"
import * as RuntimeTools from "../../src/runtime/tools"
import * as ThreadToolkits from "../../src/catalog/thread-toolkits"
import * as ThreadFind from "../../src/catalog/thread-find"
import * as WebSearchInputContract from "../../src/web-research/search/input"
import * as WebSearchRequestContract from "../../src/web-research/search/request"
import * as ProcessRegistry from "@rika/coding-tools/shell-process-registry"
import * as Runtime from "@rika/coding-tools/coding-tool-runtime"
export const contractFixtures = {
  RuntimeContract,
  RuntimeCoreTools,
  RuntimeServiceTools,
  RuntimeTools,
  ThreadToolkits,
  ThreadFind,
  WebSearchInputContract,
  WebSearchRequestContract,
  ProcessRegistry,
  Runtime,
}
