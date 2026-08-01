import type { InteractiveEvent } from "@rika/product/interactive-event"
import { Effect, Schema } from "effect"
import { Fixtures as RuntimeFixtures } from "./interactive-session-runtime-support"
import { Fixtures as TranscriptFixtures } from "./interactive-session-transcript-support"

interface ObservedProjectionStream {
  readonly turn: RuntimeFixtures.Turn.AgentExecutionTurn
  readonly streamId: string
  readonly patchRevision: number
  readonly state: Extract<InteractiveEvent, { readonly _tag: "TranscriptProjectionStarted" }>["state"]
  readonly units: ReadonlyMap<string, TranscriptFixtures.TranscriptUnit.Unit>
  readonly rootStatus?: "completed" | "failed" | "cancelled"
}

const observedProjectionEntries = (
  stream: ObservedProjectionStream,
): ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry> => {
  const turn = stream.rootStatus === undefined ? stream.turn : { ...stream.turn, status: stream.rootStatus }
  return [...stream.units.values()].map((unit) => ({
    turn,
    unit,
    projectionRevision: stream.state.revision,
    projectionModelPhase: stream.state.modelPhase,
  }))
}

const sortObservedEntries = (entries: ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry>) =>
  entries.toSorted(
    (left, right) =>
      left.turn.createdAt - right.turn.createdAt ||
      String(left.turn.id).localeCompare(String(right.turn.id)) ||
      TranscriptFixtures.TranscriptOrdering.compareUnitOrder(left.unit.order, right.unit.order),
  )

const latestSelectionEntries = (events: ReadonlyArray<InteractiveEvent>) => {
  let entries: ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry> | undefined
  let selectionEpoch: number | undefined
  let threadId: string | undefined
  const streams = new Map<string, ObservedProjectionStream>()
  for (const event of events) {
    if (event._tag === "SelectionLoaded") {
      entries = event.entries
      selectionEpoch = event.selectionEpoch
      threadId = String(event.thread.id)
      streams.clear()
      continue
    }
    if (event._tag === "TranscriptProjectionStarted") {
      if (!RuntimeFixtures.ThreadResult.TurnResult.isAgentExecution(event.turn)) continue
      if (
        selectionEpoch !== undefined &&
        (event.selectionEpoch !== selectionEpoch || String(event.threadId) !== threadId)
      )
        continue
      selectionEpoch = event.selectionEpoch
      threadId = String(event.threadId)
      streams.set(String(event.rootTurnId), {
        turn: event.turn,
        streamId: event.streamId,
        patchRevision: event.patchRevision,
        state: event.state,
        units: new Map(event.units.map((unit) => [unit.key, unit])),
        ...(event.rootStatus === undefined ? {} : { rootStatus: event.rootStatus }),
      })
      continue
    }
    if (event._tag === "TranscriptProjectionPatched") {
      if (event.selectionEpoch !== selectionEpoch || String(event.threadId) !== threadId) continue
      const rootTurnId = String(event.rootTurnId)
      const current = streams.get(rootTurnId)
      if (
        current === undefined ||
        current.streamId !== event.streamId ||
        current.patchRevision !== event.baseRevision ||
        event.patchRevision !== event.baseRevision + 1
      )
        continue
      const units = new Map(current.units)
      for (const key of event.delta.remove) units.delete(key)
      for (const unit of event.delta.upsert) units.set(unit.key, unit)
      streams.set(rootTurnId, {
        ...current,
        patchRevision: event.patchRevision,
        state: event.state,
        units,
        ...(event.rootStatus === undefined ? {} : { rootStatus: event.rootStatus }),
      })
      continue
    }
    if (event._tag === "TranscriptProjectionStopped") {
      if (event.selectionEpoch !== selectionEpoch || String(event.threadId) !== threadId) continue
      const rootTurnId = String(event.rootTurnId)
      const current = streams.get(rootTurnId)
      if (current === undefined || current.streamId !== event.streamId || current.patchRevision !== event.patchRevision)
        continue
      streams.set(rootTurnId, { ...current, rootStatus: event.status })
    }
  }
  if (entries === undefined && streams.size === 0) return undefined
  const roots = new Set(streams.keys())
  return sortObservedEntries([
    ...(entries ?? []).filter((entry) => !roots.has(String(entry.turn.id))),
    ...[...streams.values()].flatMap(observedProjectionEntries),
  ])
}

function awaitSelectionEntriesImplementation(
  events: ReadonlyArray<InteractiveEvent>,
  until: (entries: ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry>) => boolean,
): Effect.Effect<ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry>>
function awaitSelectionEntriesImplementation(
  until: (entries: ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry>) => boolean,
): (events: ReadonlyArray<InteractiveEvent>) => Effect.Effect<ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry>>
function awaitSelectionEntriesImplementation(
  eventsOrUntil:
    | ReadonlyArray<InteractiveEvent>
    | ((entries: ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry>) => boolean),
  until?: (entries: ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry>) => boolean,
):
  | Effect.Effect<ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry>>
  | ((events: ReadonlyArray<InteractiveEvent>) => Effect.Effect<ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry>>) {
  if (typeof eventsOrUntil === "function") {
    return (events: ReadonlyArray<InteractiveEvent>) => awaitSelectionEntriesImplementation(events, eventsOrUntil)
  }
  if (until === undefined) throw new Error("Invalid selection wait arguments")
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const entries = latestSelectionEntries(eventsOrUntil)
      if (entries !== undefined && until(entries)) return entries
      yield* Effect.yieldNow
    }
    return latestSelectionEntries(eventsOrUntil) ?? []
  })
}

type SelectionLoadedEvent = Extract<InteractiveEvent, { readonly _tag: "SelectionLoaded" }>
type TranscriptPagePrependedEvent = Extract<InteractiveEvent, { readonly _tag: "TranscriptPagePrepended" }>

function awaitSelectionLoadedImplementation(
  events: ReadonlyArray<InteractiveEvent>,
  until: (event: SelectionLoadedEvent) => boolean,
): Effect.Effect<SelectionLoadedEvent>
function awaitSelectionLoadedImplementation(
  until: (event: SelectionLoadedEvent) => boolean,
): (events: ReadonlyArray<InteractiveEvent>) => Effect.Effect<SelectionLoadedEvent>
function awaitSelectionLoadedImplementation(
  eventsOrUntil: ReadonlyArray<InteractiveEvent> | ((event: SelectionLoadedEvent) => boolean),
  until?: (event: SelectionLoadedEvent) => boolean,
) {
  if (typeof eventsOrUntil === "function") {
    return (events: ReadonlyArray<InteractiveEvent>) => awaitSelectionLoadedImplementation(events, eventsOrUntil)
  }
  if (until === undefined) throw new Error("Invalid selection wait arguments")
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const event = eventsOrUntil.findLast(
        (candidate): candidate is SelectionLoadedEvent => candidate._tag === "SelectionLoaded" && until(candidate),
      )
      if (event !== undefined) return event
      yield* Effect.yieldNow
    }
    const detail = eventsOrUntil.map((event) => {
      if (event._tag === "SelectionLoaded")
        return {
          tag: event._tag,
          entries: event.entries.map((entry) => entry.unit.key),
          hasOlder: event.hasOlder,
          oldestCursor: event.oldestCursor,
        }
      if (event._tag === "ExecutionFailed") return { tag: event._tag, message: event.message }
      return { tag: event._tag }
    })
    const encoded = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(detail).pipe(Effect.orDie)
    return yield* Effect.die(`selection did not load the expected transcript page: ${encoded}`)
  })
}

function awaitPrependedPageImplementation(
  events: ReadonlyArray<InteractiveEvent>,
  previousCount: number,
): Effect.Effect<TranscriptPagePrependedEvent>
function awaitPrependedPageImplementation(
  previousCount: number,
): (events: ReadonlyArray<InteractiveEvent>) => Effect.Effect<TranscriptPagePrependedEvent>
function awaitPrependedPageImplementation(
  eventsOrCount: ReadonlyArray<InteractiveEvent> | number,
  previousCount?: number,
) {
  if (typeof eventsOrCount === "number")
    return (events: ReadonlyArray<InteractiveEvent>) => awaitPrependedPageImplementation(events, eventsOrCount)
  if (previousCount === undefined) throw new Error("Invalid page wait arguments")
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const pages = eventsOrCount.filter(
        (event): event is TranscriptPagePrependedEvent => event._tag === "TranscriptPagePrepended",
      )
      if (pages.length > previousCount) return pages.at(-1)!
      yield* Effect.yieldNow
    }
    return yield* Effect.die("older transcript page did not load")
  })
}

type AwaitSelectionEntries = {
  (
    events: ReadonlyArray<InteractiveEvent>,
    until: (entries: ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry>) => boolean,
  ): Effect.Effect<ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry>>
  (
    until: (entries: ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry>) => boolean,
  ): (events: ReadonlyArray<InteractiveEvent>) => Effect.Effect<ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry>>
}
type AwaitSelectionLoaded = {
  (
    events: ReadonlyArray<InteractiveEvent>,
    until: (event: SelectionLoadedEvent) => boolean,
  ): Effect.Effect<SelectionLoadedEvent>
  (
    until: (event: SelectionLoadedEvent) => boolean,
  ): (events: ReadonlyArray<InteractiveEvent>) => Effect.Effect<SelectionLoadedEvent>
}
type AwaitPrependedPage = {
  (events: ReadonlyArray<InteractiveEvent>, previousCount: number): Effect.Effect<TranscriptPagePrependedEvent>
  (previousCount: number): (events: ReadonlyArray<InteractiveEvent>) => Effect.Effect<TranscriptPagePrependedEvent>
}

export const awaitSelectionEntries: AwaitSelectionEntries = awaitSelectionEntriesImplementation
export const awaitSelectionLoaded: AwaitSelectionLoaded = awaitSelectionLoadedImplementation
export const awaitPrependedPage: AwaitPrependedPage = awaitPrependedPageImplementation
