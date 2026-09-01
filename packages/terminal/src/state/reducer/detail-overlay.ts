import type { Message } from "../message"
import type { Model } from "../model"
import {
  expandableRowIds,
  isTranscriptUnitExpanded,
  transcriptUnits,
  transcriptUnitId,
} from "../../presentation/transcript/row"

const moveDetail = (model: Model, message: Extract<Message, { readonly _tag: "DetailMoved" }>): Model => {
  const ids = expandableRowIds(model)
  const count = ids.length
  if (count === 0) return model
  const current = ids.indexOf(model.detailSelection ?? "")
  let nextIndex: number
  if (current < 0) nextIndex = message.offset < 0 ? count - 1 : 0
  else nextIndex = (((current + message.offset) % count) + count) % count
  return { ...model, detailSelection: ids[nextIndex]! }
}

const toggleDetail = (model: Model, message: Extract<Message, { readonly _tag: "DetailToggled" }>): Model => {
  const id = message.id ?? model.detailSelection
  if (id === undefined || !expandableRowIds(model).includes(id)) return model
  const expanded = new Set(model.expandedRowKeys)
  const explicitlyCollapsed = new Set(model.explicitlyCollapsedRowKeys)
  const unit = transcriptUnits(model).find((candidate) => transcriptUnitId(model, candidate) === id)
  const currentlyExpanded = unit === undefined ? expanded.has(id) : isTranscriptUnitExpanded(model, unit)
  if (currentlyExpanded) {
    expanded.delete(id)
    explicitlyCollapsed.add(id)
  } else {
    expanded.add(id)
    explicitlyCollapsed.delete(id)
  }
  return {
    ...model,
    detailSelection: message.id === undefined ? id : model.detailSelection,
    expandedRowKeys: [...expanded],
    explicitlyCollapsedRowKeys: [...explicitlyCollapsed],
  }
}

const toggleAllDetails = (model: Model): Model => {
  const roots = expandableRowIds({ ...model, expandedRowKeys: [], explicitlyCollapsedRowKeys: [] })
  if (roots.length === 0) return model
  const all = expandableRowIds({
    ...model,
    expandedRowKeys: roots,
    explicitlyCollapsedRowKeys: [],
  })
  const expanded = new Set(model.expandedRowKeys)
  const collapseAll = all.every((id) => expanded.has(id))
  return {
    ...model,
    expandedRowKeys: collapseAll ? [] : [...all],
    explicitlyCollapsedRowKeys: collapseAll ? [...all] : [],
  }
}

const reduce = (model: Model, message: Message): Model | undefined => {
  switch (message._tag) {
    case "DetailMoved":
      return moveDetail(model, message)
    case "DetailToggled":
      return toggleDetail(model, message)
    case "AllDetailsToggled":
      return toggleAllDetails(model)
    default:
      return undefined
  }
}

export const detailOverlay = { reduce }
