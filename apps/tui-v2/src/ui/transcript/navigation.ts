import { Function } from "effect"
import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core"
import type { TranscriptGroup } from "./presenter"
import { isActive } from "./presenter"
import { toolDefaultExpanded, toolExpandable, toolHasBody } from "./content"

const defaultExpandedForGroup = (group: TranscriptGroup, id: string): boolean => {
  if (group.kind === "item") return false
  if (group.kind === "children") {
    const item = group.items.find((candidate) => candidate.id === id)
    return item === undefined ? false : isActive(item.status)
  }
  if (id === group.id) return toolDefaultExpanded(group.items)
  const child = group.items.find((tool) => `tool-child:${tool.item.id}` === id)
  return child === undefined ? false : isActive(child.item.status)
}

const groupContainsId = (group: TranscriptGroup, id: string): boolean => {
  if (group.kind === "item") return group.item.id === id
  if (group.kind === "children") return group.items.some((item) => item.id === id)
  return group.id === id || group.items.some((tool) => `tool-child:${tool.item.id}` === id)
}

export const defaultExpandedForId: {
  (groups: readonly TranscriptGroup[], id: string): boolean
  (id: string): (groups: readonly TranscriptGroup[]) => boolean
} = Function.dual(2, (groups: readonly TranscriptGroup[], id: string): boolean => {
  const group = groups.find((candidate) => groupContainsId(candidate, id))
  return group === undefined ? false : defaultExpandedForGroup(group, id)
})

export const allExpandableIdsFor = (groups: readonly TranscriptGroup[]): readonly string[] => {
  const ids: string[] = []
  for (const group of groups) {
    if (group.kind === "item") {
      if (group.item.kind === "diff") ids.push(group.item.id)
      continue
    }
    if (group.kind === "children") {
      for (const item of group.items) if (item.text.trim().length > 0) ids.push(item.id)
      continue
    }
    if (toolExpandable(group.items)) ids.push(group.id)
    if (group.items.length > 1) {
      for (const tool of group.items) if (toolHasBody(tool)) ids.push(`tool-child:${tool.item.id}`)
    }
  }
  return ids
}

export const defaultExpansionsFor = (groups: readonly TranscriptGroup[]): ReadonlyMap<string, boolean> => {
  const defaults = new Map<string, boolean>()
  for (const group of groups) {
    if (group.kind === "item") {
      if (group.item.kind === "diff") defaults.set(group.item.id, false)
      continue
    }
    if (group.kind === "children") {
      for (const item of group.items) {
        if (item.text.trim().length > 0) defaults.set(item.id, isActive(item.status))
      }
      continue
    }
    if (toolExpandable(group.items)) defaults.set(group.id, toolDefaultExpanded(group.items))
    if (group.items.length > 1) {
      for (const tool of group.items) {
        if (toolHasBody(tool)) defaults.set(`tool-child:${tool.item.id}`, isActive(tool.item.status))
      }
    }
  }
  return defaults
}

type Expanded = (id: string, fallback: boolean) => boolean
export const navigableIdsFor: {
  (groups: readonly TranscriptGroup[], isExpanded: Expanded): readonly string[]
  (isExpanded: Expanded): (groups: readonly TranscriptGroup[]) => readonly string[]
} = Function.dual(2, (groups: readonly TranscriptGroup[], isExpanded: Expanded): readonly string[] => {
  const ids: string[] = []
  for (const group of groups) {
    if (group.kind === "item") {
      if (group.item.kind === "diff") ids.push(group.item.id)
      continue
    }
    if (group.kind === "children") {
      for (const item of group.items) if (item.text.trim().length > 0) ids.push(item.id)
      continue
    }
    if (!toolExpandable(group.items)) continue
    ids.push(group.id)
    if (!isExpanded(group.id, toolDefaultExpanded(group.items))) continue
    if (group.items.length > 1) {
      for (const tool of group.items) if (toolHasBody(tool)) ids.push(`tool-child:${tool.item.id}`)
    }
  }
  return ids
})

const normalizedKey = (event: KeyEvent): string => event.name.toLowerCase().replace(/[ _-]/g, "")

export const scrollForKey: {
  (scroll: ScrollBoxRenderable, event: KeyEvent): boolean
  (event: KeyEvent): (scroll: ScrollBoxRenderable) => boolean
} = Function.dual(2, (scroll: ScrollBoxRenderable, event: KeyEvent): boolean => {
  const key = normalizedKey(event)
  const page = Math.max(1, scroll.height - 1)
  switch (key) {
    case "up":
    case "arrowup":
      scroll.scrollBy({ x: 0, y: -1 })
      return true
    case "down":
    case "arrowdown":
      scroll.scrollBy({ x: 0, y: 1 })
      return true
    case "pageup":
      scroll.scrollBy({ x: 0, y: -page })
      return true
    case "pagedown":
      scroll.scrollBy({ x: 0, y: page })
      return true
    case "home":
      scroll.scrollTo({ x: 0, y: 0 })
      return true
    case "end":
      scroll.scrollTo({ x: 0, y: Math.max(0, scroll.scrollHeight - scroll.height) })
      return true
    default:
      return false
  }
})
