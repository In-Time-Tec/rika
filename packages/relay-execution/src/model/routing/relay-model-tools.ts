import * as WebSearchProvider from "@rika/coding-tools/web-search-provider"
import * as RikaToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as AgentToolkits from "@rika/coding-tools/agent-tool-contract"
import { Tool, Toolkit, type Toolkit as AiToolkit } from "effect/unstable/ai"

export const toolkitFor = <AdditionalTools extends Record<string, Tool.Any>>(options: {
  readonly additionalToolkit?: AiToolkit.Toolkit<AdditionalTools>
}) =>
  Toolkit.make(
    ...(Object.values(RikaToolRuntime.toolkit.tools) as Array<Tool.Any>),
    ...(Object.values(AgentToolkits.AgentContract.modelToolkit.tools) as Array<Tool.Any>),
    ...(Object.values(AgentToolkits.AgentContract.joinToolkit.tools) as Array<Tool.Any>),
    ...(Object.values(options.additionalToolkit?.tools ?? {}) as Array<Tool.Any>),
  )

export const availableTools = <AdditionalTools extends Record<string, Tool.Any>>(input: {
  readonly options: { readonly additionalToolkit?: AiToolkit.Toolkit<AdditionalTools> }
  readonly names: ReadonlyArray<string>
}) => {
  const available = toolkitFor(input.options).tools
  return input.names.filter((name) => name in available)
}

export const webSearchFactories: typeof WebSearchProvider.configuredProviderFactories =
  WebSearchProvider.configuredProviderFactories
