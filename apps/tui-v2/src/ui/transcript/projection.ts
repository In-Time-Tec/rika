import { createMemo, mapArray, type Accessor } from "solid-js"
import type { TranscriptItem } from "../../client/model"
import {
  buildTranscriptGroups,
  toolFamily,
  toolPresentation,
  type ToolPresentation,
  type TranscriptGroup,
} from "./presenter"

const sameMembers = (left: TranscriptGroup, right: TranscriptGroup): boolean => {
  if (left.kind === "item") return right.kind === "item" && left.item === right.item
  if (right.kind === "item" || left.kind !== right.kind) return false
  return left.items.length === right.items.length && left.items.every((item, index) => item === right.items[index])
}

export const createTranscriptProjection = (items: Accessor<readonly TranscriptItem[]>) => {
  const tools = new WeakMap<TranscriptItem, ToolPresentation>()
  const prepared = mapArray(items, (item) => {
    if (item.kind === "tool") {
      let cached: ToolPresentation | undefined
      let title: string | undefined
      let text: string | undefined
      const presentation = () => {
        const nextTitle = item.title
        const nextText = item.text
        if (cached === undefined || title !== nextTitle || text !== nextText) {
          cached = toolPresentation(item)
          title = nextTitle
          text = nextText
        }
        return cached
      }
      const family = createMemo(() => toolFamily(item))
      tools.set(item, {
        item,
        get family() {
          return family()
        },
        get action() {
          return presentation().action
        },
        get paths() {
          return presentation().paths
        },
        get command() {
          return presentation().command
        },
        get output() {
          return presentation().output
        },
        get hasBody() {
          return presentation().hasBody
        },
        get additions() {
          return presentation().additions
        },
        get removals() {
          return presentation().removals
        },
      })
    }
    return item
  })
  return createMemo<readonly TranscriptGroup[]>((previous) => {
    const groups = buildTranscriptGroups(prepared(), (item) => tools.get(item)!)
    const previousById = new Map(previous?.map((group) => [group.id, group]))
    return groups.map((group) => {
      const existing = previousById.get(group.id)
      return existing !== undefined && sameMembers(existing, group) ? existing : group
    })
  })
}
