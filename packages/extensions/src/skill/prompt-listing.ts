import { Function } from "effect"
import type { Executable } from "./registry-model"

export interface Input {
  readonly listings: ReadonlyArray<string>
  readonly executable: ReadonlyArray<Executable>
}

export interface Options {
  readonly maxSkills?: number
  readonly maxLineLength?: number
}

export const defaultOptions = { maxSkills: 40, maxLineLength: 200 } as const

const truncate = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`

/**
 * Progressive disclosure is the whole point: a skill costs its name and one capped description line
 * in the prompt, never its body. Output size depends only on the supplied bounds.
 */
const formatImplementation = (input: Input, options?: Options): string => {
  const maxSkills = options?.maxSkills ?? defaultOptions.maxSkills
  const maxLineLength = options?.maxLineLength ?? defaultOptions.maxLineLength
  const importable = new Map(
    input.executable.filter((entry) => entry.importable).map((entry) => [entry.name, entry.importName] as const),
  )
  const sections: Array<string> = []
  if (input.listings.length > 0) {
    const shown = input.listings.slice(0, maxSkills)
    const lines = shown.map((listing) => truncate(listing, maxLineLength))
    const omitted = input.listings.length - shown.length
    sections.push(["## Skills", ...lines, ...(omitted > 0 ? [`- (${omitted} more not listed)`] : [])].join("\n"))
  }
  if (importable.size > 0) {
    const entries = [...importable].slice(0, maxSkills)
    const lines = entries.map(([name, importName]) => truncate(`- ${name}: import from "${importName}"`, maxLineLength))
    const omitted = importable.size - entries.length
    sections.push(
      [
        "## Executable skills",
        "Importable inside a cell by name.",
        ...lines,
        ...(omitted > 0 ? [`- (${omitted} more not listed)`] : []),
      ].join("\n"),
    )
  }
  const untrusted = input.executable.filter((entry) => !entry.importable)
  if (untrusted.length > 0)
    sections.push(
      [
        "## Untrusted executable skills",
        "Listed but not importable until this Workspace is trusted.",
        ...untrusted.slice(0, maxSkills).map((entry) => truncate(`- ${entry.name}`, maxLineLength)),
      ].join("\n"),
    )
  return sections.join("\n\n")
}

export const format: {
  (options?: Options): (input: Input) => string
  (input: Input, options?: Options): string
} = Function.dual(
  (args) => typeof args[0] === "object" && args[0] !== null && "listings" in args[0],
  formatImplementation,
)
