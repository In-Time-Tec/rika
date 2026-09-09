import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { CliRenderEvents, type KeyEvent, type ScrollBoxRenderable } from "@opentui/core"
import { Effect, Schedule } from "effect"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Accessor, type JSX } from "solid-js"
import type { TranscriptItem } from "../client/model"
import { TranscriptWidth } from "./styled"
import type { TranscriptGroup } from "./transcript/presenter"
import { createTranscriptProjection } from "./transcript/projection"
import { GroupView } from "./transcript/groups"
import {
  allExpandableIdsFor,
  defaultExpandedForId,
  defaultExpansionsFor,
  navigableIdsFor,
  scrollForKey,
} from "./transcript/navigation"
import { selectedGroupIndex, transcriptAnchorId, transcriptWindow, transcriptWindowSize } from "./transcript/window"
import { colors } from "./theme"
import { AnimationViewport } from "./transcript/visibility"

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
  const renderer = useRenderer()
  const [frame, setFrame] = createSignal(0)
  const [selectedId, setSelectedId] = createSignal<string | undefined>()
  const [expansionOverrides, setExpansionOverrides] = createSignal<Record<string, boolean>>({})
  let lastNavigationSerial: number | undefined
  const animate = createMemo(() => props.animate !== false)
  const focused = createMemo(() => props.focused === true)
  const groups = createTranscriptProjection(() => props.items)
  const [windowAnchor, setWindowAnchor] = createSignal<string | undefined>()
  const windowStart = createMemo(() => {
    const anchor = windowAnchor()
    if (anchor === undefined) return undefined
    const index = selectedGroupIndex({ groups: groups(), id: anchor })
    return index < 0 ? undefined : index
  })
  const setWindowStart = (start: number | undefined) => {
    const group = start === undefined ? undefined : groups()[start]
    setWindowAnchor(group === undefined ? undefined : transcriptAnchorId(group))
  }
  const window = createMemo(() => transcriptWindow({ count: groups().length, start: windowStart() }))
  const visibleGroups = createMemo(
    () =>
      new Map(
        groups()
          .slice(window().start, window().end)
          .map((group) => [group.id, group]),
      ),
  )
  let pendingScroll: "top" | "bottom" | { readonly selectedId: string } | undefined
  const applyWindowScroll = () => {
    if (scroll === undefined) return
    if (pendingScroll === undefined) {
      if (groups().length <= transcriptWindowSize) return
      const atBottom = scroll.scrollTop + scroll.viewport.height >= scroll.scrollHeight
      if (windowStart() === undefined && !atBottom) setWindowStart(window().start)
      else if (windowStart() !== undefined && window().newer === 0 && atBottom) setWindowStart(undefined)
      return
    }
    const target = pendingScroll
    pendingScroll = undefined
    if (target === "top") scroll.scrollTo({ x: 0, y: 0 })
    else if (target === "bottom")
      scroll.scrollTo({ x: 0, y: Math.max(0, scroll.scrollHeight - scroll.viewport.height) })
    else scroll.scrollChildIntoView(`transcript-header:${target.selectedId}`)
  }
  renderer.on(CliRenderEvents.FRAME, applyWindowScroll)
  onCleanup(() => renderer.off(CliRenderEvents.FRAME, applyWindowScroll))
  const showWindow = (start: number | undefined, target: typeof pendingScroll) => {
    const previous = window()
    pendingScroll = target
    setWindowStart(start)
    if (previous.start === window().start && previous.end === window().end) applyWindowScroll()
    renderer.requestRender()
  }
  const showEarlier = () => showWindow(Math.max(0, window().start - transcriptWindowSize), "bottom")
  const showNewer = () => {
    const start = window().end
    showWindow(start + transcriptWindowSize >= groups().length ? undefined : start, "top")
  }
  const revealSelected = (id: string) => {
    const index = selectedGroupIndex({ groups: groups(), id })
    if (index < 0) return
    if (index < window().start || index >= window().end) {
      const start = Math.max(0, index - Math.floor(transcriptWindowSize / 2))
      showWindow(start + transcriptWindowSize >= groups().length ? undefined : start, { selectedId: id })
    } else {
      pendingScroll = { selectedId: id }
      renderer.requestRender()
    }
  }
  const lastItemId = createMemo(() => props.items[props.items.length - 1]?.id)
  const isExpanded = (id: string, fallback: boolean): boolean => expansionOverrides()[id] ?? fallback
  const toggle = (id: string, fallback: boolean): void => {
    setExpansionOverrides((previous) => ({ ...previous, [id]: !(previous[id] ?? fallback) }))
  }
  const allIds = () => allExpandableIdsFor(groups())
  const navigationIds = () => navigableIdsFor(groups(), isExpanded)

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
    if (current.action === "next" || current.action === "previous") {
      const ids = navigationIds()
      if (ids.length === 0) return
      const selected = selectedId()
      const currentIndex = selected === undefined ? -1 : ids.indexOf(selected)
      const id = ids[nextNavigationIndex(currentIndex, current.action, ids.length)]!
      setSelectedId(id)
      revealSelected(id)
      return
    }
    if (current.action === "toggle") {
      const selected = selectedId()
      if (selected !== undefined && allIds().includes(selected)) {
        toggle(selected, defaultExpandedForId(groups(), selected))
      }
      return
    }
    const defaults = defaultExpansionsFor(groups())
    const idsToToggle = [...defaults.keys()]
    if (idsToToggle.length === 0) return
    const shouldExpand = !idsToToggle.every((id) => isExpanded(id, defaults.get(id) ?? false))
    setExpansionOverrides((previous) => {
      const next = { ...previous }
      for (const id of idsToToggle) next[id] = shouldExpand
      return next
    })
  })

  createEffect(() => {
    const selected = selectedId()
    if (selected !== undefined && selectedGroupIndex({ groups: groups(), id: selected }) < 0) setSelectedId(undefined)
  })

  useKeyboard((event: KeyEvent) => {
    if (!focused() || scroll === undefined || event.eventType === "release" || event.defaultPrevented) return
    const key = event.name.toLowerCase().replace(/[ _-]/g, "")
    if (key === "home") {
      showWindow(0, "top")
      event.preventDefault()
      return
    }
    if (["pageup", "up", "arrowup"].includes(key) && scroll.scrollTop <= 0 && window().earlier > 0) {
      showEarlier()
      event.preventDefault()
      return
    }
    if (key === "end") {
      showWindow(undefined, "bottom")
      event.preventDefault()
      return
    }
    if (
      ["pagedown", "down", "arrowdown"].includes(key) &&
      scroll.scrollTop + scroll.viewport.height >= scroll.scrollHeight &&
      window().newer > 0
    ) {
      showNewer()
      event.preventDefault()
      return
    }
    if (scrollForKey(scroll, event)) event.preventDefault()
  })

  return (
    <TranscriptWidth.Provider value={() => props.width ?? dimensions().width}>
      <AnimationViewport.Provider value={() => scroll}>
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
          stickyScroll={windowStart() === undefined}
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
          <Show when={window().earlier > 0}>
            <text
              id="transcript-earlier"
              height={1}
              flexShrink={0}
              fg={colors.muted}
              selectable={false}
              onMouseDown={showEarlier}
            >
              {`Show earlier messages (${window().earlier} groups)`}
            </text>
          </Show>
          <For each={[...visibleGroups().keys()]}>
            {(id) => (
              <box id={`transcript-group:${id}`} width="100%" flexDirection="column" flexShrink={0}>
                <GroupView
                  group={visibleGroups().get(id)!}
                  active={props.active && isLastItem(visibleGroups().get(id)!, lastItemId())}
                  animate={animate}
                  frame={frame}
                  isExpanded={isExpanded}
                  toggle={toggle}
                  selected={selectedId}
                  select={setSelectedId}
                />
              </box>
            )}
          </For>
          <Show when={window().newer > 0}>
            <text
              id="transcript-newer"
              height={1}
              flexShrink={0}
              fg={colors.muted}
              selectable={false}
              onMouseDown={showNewer}
            >
              {`Show newer messages (${window().newer} groups)`}
            </text>
          </Show>
        </scrollbox>
      </AnimationViewport.Provider>
    </TranscriptWidth.Provider>
  )
}
