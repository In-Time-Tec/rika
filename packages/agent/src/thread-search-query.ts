import { Common } from "@rika/schema"

export type RelativeDateUnit = "h" | "d" | "w"

export interface RelativeDateFilter {
  readonly _tag: "relative"
  readonly amount: number
  readonly unit: RelativeDateUnit
}

export interface AbsoluteDateFilter {
  readonly _tag: "absolute"
  readonly value: string
}

export type DateFilter = RelativeDateFilter | AbsoluteDateFilter

export interface ParsedThreadSearchQuery {
  readonly terms: ReadonlyArray<string>
  readonly file_globs: ReadonlyArray<string>
  readonly after?: DateFilter
  readonly before?: DateFilter
  readonly archived?: boolean
  readonly project?: string
}

export const parseThreadSearchQuery = (query: string): ParsedThreadSearchQuery => {
  const terms: Array<string> = []
  const fileGlobs: Array<string> = []
  let after: DateFilter | undefined
  let before: DateFilter | undefined
  let archived: boolean | undefined
  let project: string | undefined

  for (const token of scanTokens(query)) {
    const parsed = parseFilter(token)
    if (parsed === undefined) {
      terms.push(token.toLowerCase())
    } else if (parsed.key === "file") {
      fileGlobs.push(parsed.value)
    } else if (parsed.key === "after") {
      after = parsed.value
    } else if (parsed.key === "before") {
      before = parsed.value
    } else if (parsed.key === "archived") {
      archived = parsed.value
    } else {
      project = parsed.value
    }
  }

  return {
    terms: unique(terms),
    file_globs: unique(fileGlobs),
    ...(after === undefined ? {} : { after }),
    ...(before === undefined ? {} : { before }),
    ...(archived === undefined ? {} : { archived }),
    ...(project === undefined ? {} : { project }),
  }
}

export const resolveDateFilter = (
  filter: DateFilter,
  now: Common.TimestampMillis,
): Common.TimestampMillis | undefined => {
  if (filter._tag === "absolute") {
    const parsed = Date.parse(filter.value)
    return Number.isNaN(parsed) ? undefined : Common.TimestampMillis.make(parsed)
  }
  const delta = filter.amount * unitMillis(filter.unit)
  return Common.TimestampMillis.make(now - delta)
}

export const matchesFileGlob = (path: string, glob: string): boolean => {
  const normalizedPath = normalizePath(path)
  const normalizedGlob = normalizePath(glob)
  const regexp = globRegExp(normalizedGlob)
  if (regexp.test(normalizedPath)) return true
  if (normalizedGlob.includes("/")) return false
  return regexp.test(normalizedPath.split("/").at(-1) ?? normalizedPath)
}

const parseFilter = (
  token: string,
):
  | { readonly key: "file"; readonly value: string }
  | { readonly key: "after"; readonly value: DateFilter }
  | { readonly key: "before"; readonly value: DateFilter }
  | { readonly key: "archived"; readonly value: boolean }
  | { readonly key: "project"; readonly value: string }
  | undefined => {
  const index = token.indexOf(":")
  if (index <= 0) return undefined
  const key = token.slice(0, index).toLowerCase()
  const value = token.slice(index + 1).trim()
  if (value.length === 0) return undefined
  if (key === "file") return { key, value }
  if (key === "project") return { key, value }
  if (key === "after" || key === "before") {
    const date = parseDateFilter(value)
    return date === undefined ? undefined : { key, value: date }
  }
  if (key === "archived") {
    if (value === "true") return { key, value: true }
    if (value === "false") return { key, value: false }
  }
  return undefined
}

const parseDateFilter = (value: string): DateFilter | undefined => {
  const relative = /^([1-9][0-9]*)([hdw])$/.exec(value)
  if (relative?.[1] !== undefined && isRelativeDateUnit(relative[2])) {
    return { _tag: "relative", amount: Number(relative[1]), unit: relative[2] }
  }
  return Number.isNaN(Date.parse(value)) ? undefined : { _tag: "absolute", value }
}

const scanTokens = (query: string): ReadonlyArray<string> => {
  const tokens: Array<string> = []
  let current = ""
  let quoted = false
  let escaped = false
  for (const char of query) {
    if (escaped) {
      current += char
      escaped = false
    } else if (quoted && char === "\\") {
      escaped = true
    } else if (char === '"') {
      quoted = !quoted
    } else if (!quoted && /\s/.test(char)) {
      if (current.length > 0) tokens.push(current)
      current = ""
    } else {
      current += char
    }
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}

const globRegExp = (glob: string): RegExp => {
  let pattern = "^"
  let index = 0
  while (index < glob.length) {
    const char = glob[index]
    const next = glob[index + 1]
    const afterNext = glob[index + 2]
    if (char === "*" && next === "*" && afterNext === "/") {
      pattern += "(?:.*/)?"
      index += 3
    } else if (char === "*" && next === "*") {
      pattern += ".*"
      index += 2
    } else if (char === "*") {
      pattern += "[^/]*"
      index += 1
    } else if (char === "?") {
      pattern += "[^/]"
      index += 1
    } else {
      pattern += escapeRegExp(char ?? "")
      index += 1
    }
  }
  return new RegExp(`${pattern}$`)
}

const unitMillis = (unit: RelativeDateUnit) => {
  if (unit === "h") return 60 * 60 * 1_000
  if (unit === "d") return 24 * 60 * 60 * 1_000
  return 7 * 24 * 60 * 60 * 1_000
}

const isRelativeDateUnit = (value: string | undefined): value is RelativeDateUnit =>
  value === "h" || value === "d" || value === "w"

const normalizePath = (value: string) => value.trim().replace(/\\/g, "/").replace(/^\.\//, "")
const escapeRegExp = (value: string) => value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
const unique = (values: ReadonlyArray<string>) => [...new Set(values.filter((value) => value.length > 0))]
