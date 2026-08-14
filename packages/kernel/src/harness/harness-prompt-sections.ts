import { HarnessOverview, HarnessState } from "@batonfx/harness"

export interface Input {
  readonly harness: HarnessState.HarnessState
  readonly skillListings: string
  readonly mcpServers: ReadonlyArray<string>
  readonly overviewOptions?: HarnessOverview.OverviewOptions
}

export interface Section {
  readonly name: string
  readonly text: string
}

const mcpSection = (servers: ReadonlyArray<string>): string =>
  [
    "MCP servers are reachable as rika.mcp.<server>.<tool>(input). Call rika.mcp.tools({ server }) for schemas.",
    ...servers.map((server) => `- ${server}`),
  ].join("\n")

/**
 * The supplemental sections one Execution adds to its context.
 *
 * The base prompt is immutable: this returns only additions, never a rewritten prompt, so a harness
 * entry can extend what the model knows but can never displace Rika's own instructions. Everything
 * here is bounded — the harness overview by `HarnessOverview` limits, skills by their own formatter,
 * MCP by server NAMES ONLY, because a server with forty tools must cost three words rather than
 * forty schemas.
 */
export const sections = (input: Input): ReadonlyArray<Section> => [
  { name: "continual-harness", text: HarnessOverview.formatOverview(input.harness, input.overviewOptions ?? {}) },
  ...(input.skillListings.length === 0 ? [] : [{ name: "skills", text: input.skillListings }]),
  ...(input.mcpServers.length === 0 ? [] : [{ name: "mcp-servers", text: mcpSection(input.mcpServers) }]),
]

/** The supplemental block appended after the immutable base prompt. */
export const block = (input: Input): string =>
  sections(input)
    .map((section) => `<${section.name}>\n${section.text}\n</${section.name}>`)
    .join("\n\n")
