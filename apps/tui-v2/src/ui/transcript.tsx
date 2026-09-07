import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core"
import { Effect, Schedule } from "effect"
import { For, createEffect, createMemo, createSignal, onCleanup, type Accessor, type JSX } from "solid-js"
import type { TranscriptItem } from "../client/model"
import { TranscriptWidth } from "./styled"
import { buildTranscriptGroups, type TranscriptGroup } from "./transcript/presenter"
import { GroupView } from "./transcript/groups"
import { allExpandableIdsFor, defaultExpandedForId, navigableIdsFor, scrollForKey } from "./transcript/navigation"

export interface TranscriptNavigation {
  readonly serial: number
  readonly action: "next" | "previous" | "toggle" | "all"
}

export interface TranscriptProps {
  readonly items: readonly TranscriptItem[]
  readonly active: boolean
  readonly focused?: boolean
  readonly animate?: boolean
  readonly navigation?: Accessor<TranscriptNavigation | undefined>
  readonly width?: number
}

const nextNavigationIndex = (currentIndex: number, action: "next" | "previous", length: number): number => {
  if (currentIndex < 0) return action === "next" ? 0 : length - 1
  const offset = action === "next" ? 1 : -1
  return (currentIndex + offset + length) % length
}

const isLastItem = (group: TranscriptGroup, lastItemId: string | undefined): boolean =>
  group.kind === "item" && group.item.id === lastItemId

export const Transcript = (props: TranscriptProps): JSX.Element => {
  let scroll: ScrollBoxRenderable | undefined
  const dimensions = useTerminalDimensions()
  const [frame, setFrame] = createSignal(0)
  const [selectedId, setSelectedId] = createSignal<string | undefined>()
  const [expansionOverrides, setExpansionOverrides] = createSignal<Record<string, boolean>>({})
  let lastNavigationSerial: number | undefined
  const animate = createMemo(() => props.animate !== false)
  const focused = createMemo(() => props.focused === true)
  const groups = createMemo(() => buildTranscriptGroups(props.items))
  const lastItemId = createMemo(() => props.items[props.items.length - 1]?.id)
  const isExpanded = (id: string, fallback: boolean): boolean => expansionOverrides()[id] ?? fallback
  const toggle = (id: string, fallback: boolean): void => {
    setExpansionOverrides((previous) => ({ ...previous, [id]: !(previous[id] ?? fallback) }))
  }
  const allIds = createMemo(() => allExpandableIdsFor(groups()))
  const navigationIds = createMemo(() => navigableIdsFor(groups(), isExpanded))

  createEffect(() => {
    if (!animate() || !props.active) return
    const timer = Effect.runFork(
      Effect.repeat(
        Effect.sync(() => setFrame((value) => value + 1)),
        Schedule.spaced(100),
      ),
    )
    onCleanup(() => timer.interruptUnsafe())
  })

  createEffect(() => {
    const current = props.navigation?.()
    if (current === undefined || current.serial === lastNavigationSerial) return
    lastNavigationSerial = current.serial
    const ids = navigationIds()
    if (current.action === "next" || current.action === "previous") {
      if (ids.length === 0) return
      const selected = selectedId()
      const currentIndex = selected === undefined ? -1 : ids.indexOf(selected)
      setSelectedId(ids[nextNavigationIndex(currentIndex, current.action, ids.length)])
      return
    }
    if (current.action === "toggle") {
      const selected = selectedId()
      if (selected !== undefined && allIds().includes(selected)) {
        toggle(selected, defaultExpandedForId(groups(), selected))
      }
      return
    }
    const idsToToggle = allIds()
    if (idsToToggle.length === 0) return
    const shouldExpand = !idsToToggle.every((id) => isExpanded(id, defaultExpandedForId(groups(), id)))
    setExpansionOverrides((previous) => {
      const next = { ...previous }
      for (const id of idsToToggle) next[id] = shouldExpand
      return next
    })
  })

  createEffect(() => {
    const selected = selectedId()
    if (selected !== undefined && !allIds().includes(selected)) setSelectedId(undefined)
  })

  useKeyboard((event: KeyEvent) => {
    if (!focused() || scroll === undefined || event.eventType === "release" || event.defaultPrevented) return
    if (scrollForKey(scroll, event)) event.preventDefault()
  })

  return (
    <TranscriptWidth.Provider value={() => props.width ?? dimensions().width}>
      <scrollbox
        ref={(value: ScrollBoxRenderable) => {
          scroll = value
        }}
        width="100%"
        height="100%"
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        scrollY
        scrollX={false}
        stickyScroll
        stickyStart="bottom"
        viewportCulling
        contentOptions={{
          flexDirection: "column",
          minHeight: "100%",
          justifyContent: "flex-end",
          paddingTop: 1,
          paddingLeft: 1,
          paddingRight: 2,
          gap: 1,
        }}
        focused={focused()}
      >
        <For each={groups()}>
          {(group) => (
            <GroupView
              group={group}
              active={props.active && isLastItem(group, lastItemId())}
              animate={animate}
              frame={frame}
              isExpanded={isExpanded}
              toggle={toggle}
              selected={selectedId}
              select={setSelectedId}
            />
          )}
        </For>
      </scrollbox>
    </TranscriptWidth.Provider>
  )
}
