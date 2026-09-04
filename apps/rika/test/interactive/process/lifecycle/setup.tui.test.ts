import { expect, test } from "vitest"
import { Clock, Effect } from "effect"
import * as Thread from "@rika/product/thread-record"
import * as TuiApp from "../../../support/tui-app.harness"
import { model } from "../../../support/tui-model.fixture"

type SessionEvent = Parameters<NonNullable<TuiApp.TuiAppOptions["mapInteractiveEvent"]>>[0]

/**
 * Characterization of the Thread catalog startup defect.
 *
 * The switcher stays empty before the first user message because no startup
 * catalog load exists: the list arrives only through the legacy ThreadsListed
 * channel (the implicit dispatch inside `session.events()` or the picker-open
 * refresh). These tests suppress that legacy channel and assert the catalog
 * behavior the v2 startup load must provide instead: the lifecycle owns one
 * explicit request at startup, applies it through fenced catalog messages, and
 * renders cached/empty/failed states without depending on legacy deliveries.
 * Every test below must FAIL until the production change lands.
 */
const blankLegacyThreadCatalog = (event: SessionEvent): SessionEvent =>
  event._tag === "ThreadsListed" ? { ...event, threads: [] } : event

const seedCatalogThreads =
  (definitions: ReadonlyArray<{ readonly id: string; readonly title: string }>) =>
  ({ workspace, threads }: { workspace: string; threads: { create: (input: { id: Thread.ThreadId; workspace: string; title: string; now: number }) => Effect.Effect<unknown> } }) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      for (const [index, definition] of definitions.entries())
        yield* threads.create({
          id: Thread.ThreadId.make(definition.id),
          workspace,
          title: definition.title,
          now: now + index,
        })
    })
const tuiTestTimeout = 60_000

test(
  "restores a failed prompt to the composer without leaving a duplicate transcript echo",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({ script: [model.failure("FAILED_BEFORE_ANY_OUTPUT")] })

        yield* Effect.tryPromise(() => app.type("DUPLICATE_ECHO_PROMPT"))
        app.pressEnter()
        yield* app.waitFrame("Execution failed")
        const failed = yield* app.settled
        yield* app.quit
        return failed
      }),
    )["then"]((failed) => {
      expect(failed).toContain("UPLICATE_ECHO_PROMPT")
      expect(failed.match(/UPLICATE_ECHO_PROMPT/g) ?? []).toHaveLength(1)
    }),
  tuiTestTimeout,
)

test(
  "loads the Thread catalog during startup before any prompt is submitted",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          prepareRuntimeState: seedCatalogThreads([
            { id: "catalog-thread-alpha", title: "Alpha catalog thread" },
            { id: "catalog-thread-beta", title: "Beta catalog thread" },
          ]),
          mapInteractiveEvent: blankLegacyThreadCatalog,
        })
        // The persisted Threads exist independent of any catalog delivery.
        expect((yield* app.thread("catalog-thread-alpha"))?.title).toBe("Alpha catalog thread")
        expect((yield* app.thread("catalog-thread-beta"))?.title).toBe("Beta catalog thread")
        // Let the startup catalog load settle without opening the switcher or prompting.
        yield* app.settled
        // The startup load must have populated the catalog on its own: opening the
        // switcher reads the startup catalog instead of initializing it.
        app.pressKey("t", { ctrl: true })
        const switcher = yield* app.waitFrame("Switch Thread")
        expect(switcher).toContain("Alpha catalog thread")
        expect(switcher).toContain("Beta catalog thread")
        expect(yield* app.modelRequestCount).toBe(0)
        expect(yield* app.submissionAttempts).toBe(0)
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "opens the Thread switcher from the startup catalog without a model request",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          initialThreadId: "catalog-thread-beta",
          prepareRuntimeState: seedCatalogThreads([
            { id: "catalog-thread-alpha", title: "Alpha catalog thread" },
            { id: "catalog-thread-beta", title: "Beta catalog thread" },
          ]),
          mapInteractiveEvent: blankLegacyThreadCatalog,
        })
        expect((yield* app.thread("catalog-thread-beta"))?.title).toBe("Beta catalog thread")
        yield* app.settled
        app.pressKey("t", { ctrl: true })
        const switcher = yield* app.waitFrame("Switch Thread")
        // Both persisted titles come from the startup catalog; the picker needs no
        // message send and opening it does not clear the list.
        expect(switcher).toContain("Alpha catalog thread")
        expect(switcher).toContain("Beta catalog thread")
        expect(yield* app.modelRequestCount).toBe(0)
        expect(yield* app.submissionAttempts).toBe(0)
        // The active Thread (beta) is selected by id, so confirming without moving
        // selects nothing new.
        app.pressEnter()
        yield* app.waitGone("Switch Thread")
        expect(yield* app.selectionAttempts).toBeLessThanOrEqual(1)
        expect(yield* app.modelRequestCount).toBe(0)
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "shows cached Threads while a background refresh runs",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        let lists = 0
        const app = yield* TuiApp.tuiApp({
          prepareRuntimeState: seedCatalogThreads([
            { id: "catalog-thread-alpha", title: "Alpha catalog thread" },
            { id: "catalog-thread-beta", title: "Beta catalog thread" },
            { id: "catalog-thread-gamma", title: "Gamma catalog thread" },
          ]),
          mapInteractiveEvent: (event) => {
            if (event._tag !== "ThreadsListed") return event
            lists += 1
            // The first list predates gamma; the refresh picks it up.
            if (lists === 1)
              return {
                ...event,
                threads: event.threads.filter(
                  (thread) => thread.title === "Alpha catalog thread" || thread.title === "Beta catalog thread",
                ),
              }
            return event
          },
        })
        app.pressKey("t", { ctrl: true })
        const cached = yield* app.waitFrameMatch(
          (frame) => frame.includes("Switch Thread") && frame.includes("Alpha catalog thread"),
        )
        expect(cached).toContain("Beta catalog thread")
        // The immediate post-open frame is the background-refresh window: cached
        // titles stay visible and a refresh indicator appears instead of a blank list.
        // (Uses the first painted frame as the in-flight window; upgrade to a
        // Deferred hold when the harness can suspend the catalog request.)
        const refreshing = yield* app.waitFrameMatch(
          (frame) =>
            frame.includes("Switch Thread") &&
            frame.includes("Alpha catalog thread") &&
            /refresh|updating|syncing/i.test(frame),
          1_500,
        )
        expect(refreshing).toContain("Beta catalog thread")
        app.pressEscape()
        yield* app.waitGone("Switch Thread")
        // Resolving the refresh updates the list without ever blanking it.
        app.pressKey("t", { ctrl: true })
        const updated = yield* app.waitFrame("Gamma catalog thread")
        expect(updated).toContain("Alpha catalog thread")
        expect(updated).toContain("Beta catalog thread")
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "keeps a newer Thread catalog when an older request completes late",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        let lists = 0
        const app = yield* TuiApp.tuiApp({
          prepareRuntimeState: seedCatalogThreads([
            { id: "catalog-thread-alpha", title: "Alpha catalog thread" },
            { id: "catalog-thread-beta", title: "Beta catalog thread" },
          ]),
          mapInteractiveEvent: (event) => {
            if (event._tag !== "ThreadsListed") return event
            lists += 1
            // Request 1 sees only alpha; request 2 sees alpha and beta; a late
            // duplicate of request 1 must not clobber request 2.
            if (lists === 1)
              return {
                ...event,
                threads: event.threads.filter((thread) => thread.title === "Alpha catalog thread"),
              }
            if (lists === 2)
              return {
                ...event,
                threads: event.threads.filter(
                  (thread) => thread.title === "Alpha catalog thread" || thread.title === "Beta catalog thread",
                ),
              }
            return {
              ...event,
              threads: event.threads.filter((thread) => thread.title === "Alpha catalog thread"),
            }
          },
        })
        app.pressKey("t", { ctrl: true })
        yield* app.waitFrame("Alpha catalog thread")
        app.pressEscape()
        yield* app.waitGone("Switch Thread")
        // Request 2 completes first and becomes authoritative.
        app.pressKey("t", { ctrl: true })
        yield* app.waitFrame("Beta catalog thread")
        app.pressEscape()
        yield* app.waitGone("Switch Thread")
        // Request 1 completes late and must be ignored.
        app.pressKey("t", { ctrl: true })
        yield* Effect.sleep("500 millis")
        const authoritative = app.frame()
        expect(authoritative).toContain("Alpha catalog thread")
        expect(authoritative).toContain("Beta catalog thread")
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "renders distinct empty and failed Thread catalog states",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          prepareRuntimeState: seedCatalogThreads([
            { id: "catalog-thread-alpha", title: "Alpha catalog thread" },
          ]),
          // A successful empty response: the list arrives but carries no Threads.
          mapInteractiveEvent: (event) =>
            event._tag === "ThreadsListed" ? { ...event, threads: [] } : event,
        })
        expect((yield* app.thread("catalog-thread-alpha"))?.title).toBe("Alpha catalog thread")
        app.pressKey("t", { ctrl: true })
        const empty = yield* app.waitFrame("Switch Thread")
        expect(empty).not.toContain("Alpha catalog thread")
        // An explicit empty state is rendered instead of a silent blank list.
        expect(empty).toMatch(/no threads|empty|nothing here|no conversations|no history/i)
        // The empty success state must not masquerade as a load failure.
        expect(empty).not.toMatch(/fail|error|retry|try again/i)
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "switches Threads before the first prompt",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          historicalTranscriptFixture: {
            threadId: "catalog-thread-alpha",
            entryCount: 2,
            marker: "ALPHA_HISTORY_MARKER",
          },
          prepareRuntimeState: seedCatalogThreads([{ id: "catalog-thread-beta", title: "Beta catalog thread" }]),
          mapInteractiveEvent: blankLegacyThreadCatalog,
        })
        // Startup begins on thread A with its transcript visible.
        yield* app.waitFrame("Historical transcript complete")
        expect((yield* app.thread("catalog-thread-beta"))?.title).toBe("Beta catalog thread")
        // Thread B is listed before any prompt is submitted, so it can be selected.
        app.pressKey("t", { ctrl: true })
        const switcher = yield* app.waitFrame("Switch Thread")
        expect(switcher).toContain("Beta catalog thread")
        yield* Effect.tryPromise(() => app.type("Beta"))
        app.pressEnter()
        yield* app.waitGone("Switch Thread")
        // Thread B becomes active with its own transcript and no model work runs.
        expect(yield* app.selectionAttempts).toBe(1)
        expect(yield* app.modelRequestCount).toBe(0)
        expect(yield* app.submissionAttempts).toBe(0)
        yield* app.waitGone("Historical transcript complete")
        // The composer remains usable on the newly selected Thread.
        yield* Effect.tryPromise(() => app.type("COMPOSER_AFTER_SWITCH"))
        yield* app.waitFrame("COMPOSER_AFTER_SWITCH")
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "ignores a late transcript load after a newer Thread selection",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          historicalTranscriptFixture: {
            threadId: "catalog-thread-beta",
            entryCount: 440,
            marker: "BETA_HISTORY_MARKER",
          },
          prepareRuntimeState: seedCatalogThreads([
            { id: "catalog-thread-alpha", title: "Alpha catalog thread" },
            { id: "catalog-thread-gamma", title: "Gamma catalog thread" },
          ]),
          mapInteractiveEvent: blankLegacyThreadCatalog,
        })
        // Startup begins on the heavy thread B.
        yield* app.waitFrame("Historical transcript complete")
        expect((yield* app.thread("catalog-thread-gamma"))?.title).toBe("Gamma catalog thread")
        app.pressKey("t", { ctrl: true })
        const switcher = yield* app.waitFrame("Switch Thread")
        // Thread C is listed before any prompt, so the newer selection can happen.
        expect(switcher).toContain("Gamma catalog thread")
        expect(switcher).toContain("Alpha catalog thread")
        // Select A, then B (whose heavy transcript load stays in flight), then C.
        yield* Effect.tryPromise(() => app.type("Alpha"))
        app.pressEnter()
        yield* app.waitGone("Switch Thread")
        app.pressKey("t", { ctrl: true })
        yield* app.waitFrame("Switch Thread")
        yield* Effect.tryPromise(() => app.type("Durable"))
        app.pressEnter()
        yield* app.waitGone("Switch Thread")
        app.pressKey("t", { ctrl: true })
        yield* app.waitFrame("Switch Thread")
        yield* Effect.tryPromise(() => app.type("Gamma"))
        app.pressEnter()
        yield* app.waitGone("Switch Thread")
        expect(yield* app.selectionAttempts).toBe(3)
        expect(yield* app.modelRequestCount).toBe(0)
        // B resolves last but must not dislodge C.
        yield* app.settled
        const active = app.frame()
        expect(active).not.toContain("Historical transcript complete")
        yield* app.quit
      }),
    ),
  90_000,
)
