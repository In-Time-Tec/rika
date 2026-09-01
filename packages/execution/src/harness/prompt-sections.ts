import { Overview, State } from "generalist/instructions"

export interface Input {
  readonly harness: State.GuidanceState
  readonly skillListings: string
  readonly overviewOptions?: Overview.OverviewOptions
}

export interface Section {
  readonly name: string
  readonly text: string
}

/**
 * The supplemental sections one Execution adds to its context.
 *
 * The base prompt is immutable: this returns only additions, never a rewritten prompt, so a harness
 * entry can extend what the model knows but can never displace Rika's own instructions. Everything
 * here is bounded: the harness overview by `Overview` limits and skills by their own formatter.
 */
export const sections = (input: Input): ReadonlyArray<Section> => [
  { name: "continual-harness", text: Overview.format(input.harness, input.overviewOptions ?? {}) },
  ...(input.skillListings.length === 0 ? [] : [{ name: "skills", text: input.skillListings }]),
]

/** The supplemental block appended after the immutable base prompt. */
export const block = (input: Input): string =>
  sections(input)
    .map((section) => `<${section.name}>\n${section.text}\n</${section.name}>`)
    .join("\n\n")
