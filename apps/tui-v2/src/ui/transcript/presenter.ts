import { Function } from "effect"
import type { Activity, TranscriptItem } from "../../client/model"

export type ToolFamily = "explore" | "edit" | "shell" | "other"
export type ToolAction = "read" | "search" | "edit" | "shell" | "other"

export interface ToolPresentation {
  readonly item: TranscriptItem
  readonly family: ToolFamily
  readonly action: ToolAction
  readonly paths: readonly string[]
  readonly command: string | undefined
  readonly output: string
  readonly additions: number
  readonly removals: number
}

export type TranscriptGroup =
  | { readonly kind: "item"; readonly id: string; readonly item: TranscriptItem }
  | { readonly kind: "tools"; readonly id: string; readonly items: readonly ToolPresentation[] }
  | { readonly kind: "children"; readonly id: string; readonly items: readonly TranscriptItem[] }

const pathWithExtension =
  /(?:^|[\s:(])((?:[./~][\w./-]+|[\w-]+(?:\/[\w.-]+)+|[\w.-]+\.(?:[a-z0-9]{1,12})))(?=$|[\s,;:)\]}'"`])/giu
const diffPath = /^(?:diff --git a\/[^\s]+ b\/([^\s]+)|\+\+\+ (?:[ab]\/)?([^\s]+))/mu
const shellLine = /^\s*\$\s*(.+?)\s*$/u

const cleanPath = (value: string): string => value.replace(/^['"`]|['"`,.;:]$/gu, "")

const pathsIn = (text: string): readonly string[] => {
  const paths: string[] = []
  for (const match of text.matchAll(pathWithExtension)) {
    const value = cleanPath(match[1] ?? "")
    if (value.length > 0 && !paths.includes(value)) paths.push(value)
  }
  const patch = diffPath.exec(text)
  const patchPath = cleanPath(patch?.[1] ?? patch?.[2] ?? "")
  if (patchPath.length > 0 && !paths.includes(patchPath)) paths.push(patchPath)
  return paths
}

const titlePaths = (item: TranscriptItem): readonly string[] => {
  const title = item.title.trim()
  if (title.length === 0 || /\s/u.test(title)) return []
  const paths = pathsIn(title)
  if (paths.length > 0) return paths
  if (/[./]/u.test(title)) return [title]
  return []
}

const familyFor = (item: TranscriptItem): ToolFamily => {
  const value = `${item.title}\n${item.text}`.toLowerCase()
  if (
    /(^|\b)(edit|edited|editing|write|wrote|writing|patch|patched|change|changed|changing|modify|modified)(\b|$)/u.test(
      value,
    ) ||
    /^diff --git /mu.test(item.text) ||
    /^@@ /mu.test(item.text)
  )
    return "edit"
  if (/(^|\b)(read|reading|view|viewed|search|searched|grep|glob|explor|inspect)(\b|$)/u.test(value)) return "explore"
  if (/(^|\b)(shell|command|run|running|ran|check|test|exit code)(\b|$)/u.test(value) || /^\s*\$/mu.test(item.text))
    return "shell"
  return "other"
}

const actionFor = (family: ToolFamily, item: TranscriptItem): ToolAction => {
  if (family === "explore")
    return /\b(search|searched|grep|glob)\b/iu.test(`${item.title}\n${item.text}`) ? "search" : "read"
  if (family === "edit") return "edit"
  if (family === "shell") return "shell"
  return "other"
}

const commandFor = (item: TranscriptItem): string | undefined => {
  const direct = item.text
    .split("\n")
    .map((line) => shellLine.exec(line)?.[1])
    .find((line) => line !== undefined)
  if (direct !== undefined && direct.length > 0) return direct
  const title = item.title.trim()
  if (/\s/u.test(title) && /\b(command|check|run|shell|test)\b/iu.test(title)) return title
  return undefined
}

export const diffCounts = (patch: string): readonly [number, number] => {
  let additions = 0
  let removals = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1
    else if (line.startsWith("-") && !line.startsWith("---")) removals += 1
  }
  return [additions, removals]
}

const outputFor = (item: TranscriptItem, command: string | undefined): string => {
  if (command === undefined) return item.text
  const lines = item.text.split("\n")
  const first = lines.findIndex((line) => shellLine.exec(line)?.[1] === command)
  return first < 0
    ? item.text
    : lines
        .slice(first + 1)
        .join("\n")
        .trim()
}

export const toolPresentation = (item: TranscriptItem): ToolPresentation => {
  const family = familyFor(item)
  const action = actionFor(family, item)
  const paths = [...new Set([...pathsIn(item.text), ...titlePaths(item)])]
  const command = action === "shell" ? commandFor(item) : undefined
  const [additions, removals] = family === "edit" ? diffCounts(item.text) : [0, 0]
  return { item, family, action, paths, command, output: outputFor(item, command), additions, removals }
}

const sameFamily = (left: ToolPresentation, right: ToolPresentation): boolean => left.family === right.family

export const buildTranscriptGroups = (items: readonly TranscriptItem[]): readonly TranscriptGroup[] => {
  const groups: TranscriptGroup[] = []
  let index = 0
  while (index < items.length) {
    const item = items[index]!
    if (item.kind === "tool") {
      const tools: ToolPresentation[] = [toolPresentation(item)]
      index += 1
      while (index < items.length && items[index]!.kind === "tool") {
        const next = toolPresentation(items[index]!)
        if (!sameFamily(tools[0]!, next)) break
        tools.push(next)
        index += 1
      }
      groups.push({ kind: "tools", id: `tool:${tools[0]!.item.id}`, items: tools })
      continue
    }
    if (item.kind === "child") {
      const children: TranscriptItem[] = [item]
      index += 1
      while (index < items.length && items[index]!.kind === "child") {
        children.push(items[index]!)
        index += 1
      }
      groups.push({ kind: "children", id: `children:${children[0]!.id}`, items: children })
      continue
    }
    groups.push({ kind: "item", id: item.id, item })
    index += 1
  }
  return groups
}

export const aggregateActivity = (statuses: readonly (Activity | undefined)[]): Activity | undefined => {
  if (statuses.includes("failed")) return "failed"
  if (statuses.includes("cancelled")) return "cancelled"
  if (statuses.includes("waiting")) return "waiting"
  if (statuses.includes("working")) return "working"
  if (statuses.includes("idle")) return "idle"
  return undefined
}

export const isActive = (status: Activity | undefined): boolean => status === "working" || status === "waiting"

export const firstPath = (tool: ToolPresentation): string | undefined => tool.paths[0]

export const plural: {
  (singular: string): (count: number) => string
  (count: number, singular: string): string
} = Function.dual(2, (count: number, singular: string): string => `${count} ${singular}${count === 1 ? "" : "s"}`)
