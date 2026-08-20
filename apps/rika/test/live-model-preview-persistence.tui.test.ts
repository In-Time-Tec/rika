import { expect, test } from "vitest"
import { Effect, FileSystem, Path } from "effect"
import { Database } from "bun:sqlite"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 90_000

test(
  "previews never persist: one durable commit per turn in rika.db and no preview frames in tenetkit.db",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fileSystem.makeTempDirectoryScoped({ directory: "/tmp", prefix: "rika-persist-" })
        const app = yield* TuiApp.tuiApp({
          root,
          // A paced multi-part stream through the production path produces many preview revisions.
          script: [model.turn([model.part("PERSISTENCE_ANSWER")], { streamPartDelayMillis: 5 })],
        })
        yield* Effect.promise(() => app.type("Prove persistence bounds."))
        app.pressEnter()
        yield* app.waitFrame("PERSISTENCE_ANSWER")
        yield* app.settled
        yield* app.quit

        const rika = new Database(path.join(root, "rika.db"), { readonly: true })
        const tenetkit = new Database(path.join(root, "tenetkit.db"), { readonly: true })
        try {
          const unitRows = rika
            .query<{ readonly n: number }, []>("SELECT COUNT(*) AS n FROM rika_transcript_units")
            .get()!.n
          const checkpointRows = rika
            .query<{ readonly n: number }, []>("SELECT COUNT(*) AS n FROM rika_transcript_checkpoints")
            .get()!.n
          const turnRows = rika.query<{ readonly n: number }, []>("SELECT COUNT(*) AS n FROM rika_turns").get()!.n
          // Exactly the prompt + one durable answer unit, one checkpoint, one turn.
          expect(unitRows).toBe(2)
          expect(checkpointRows).toBe(1)
          expect(turnRows).toBe(1)

          const unitTexts = rika
            .query<{ readonly unit_json: string }, []>("SELECT unit_json FROM rika_transcript_units")
            .all()
            .map((row) => row.unit_json)

          // No preview fragment text ever reached the durable transcript.
          expect(unitTexts.some((text) => text.includes("preview") || text.includes("tentative"))).toBe(false)

          const eventCount = tenetkit
            .query<{ readonly n: number }, []>("SELECT COUNT(*) AS n FROM tenetkit_run_events")
            .get()!.n
          const events = tenetkit
            .query<{ readonly event_json: string }, []>("SELECT event_json FROM tenetkit_run_events")
            .all()
            .map((row) => row.event_json)
          // TenetKit stored semantic events only: at least the committed response, and nothing that
          // carries a raw model part (previews are memory-only).
          expect(eventCount).toBeGreaterThanOrEqual(1)
          expect(events.some((event) => event.includes("PERSISTENCE_ANSWER"))).toBe(true)
          expect(events.some((event) => event.includes("text-delta"))).toBe(false)
        } finally {
          rika.close()
          tenetkit.close()
        }
      }),
    ),
  tuiTestTimeout,
)
