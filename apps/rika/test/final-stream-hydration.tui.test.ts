import { Database } from "bun:sqlite"
import * as TranscriptPage from "@rika/product/transcript-page"
import * as Turn from "@rika/product/turn-record"
import { Effect, FileSystem, Path, Redacted } from "effect"
import { expect, test } from "vitest"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 90_000
const answer = "FINAL_STREAM_HYDRATED"
const requestCanary = "RIKA_REQUEST_HEADER_CANARY_7e3ab87f"
const responseCanary = "RIKA_RESPONSE_HEADER_CANARY_9b48c6d1"
const requestUrl = "https://provider.invalid/v1/responses"
const responseRequestId = "req_final_stream_hydration"
const turnId = Turn.TurnId.make("tui-turn-0")
const envelope = {
  request: {
    method: "POST" as const,
    url: requestUrl,
    urlParams: [],
    hash: "",
    headers: {
      authorization: Redacted.make(requestCanary),
      "content-type": "application/json",
    },
  },
  response: {
    status: 200,
    headers: {
      "x-request-id": responseRequestId,
      "set-cookie": Redacted.make(responseCanary),
    },
  },
}

const assistantAnswers = (projection: TranscriptPage.Projection | undefined) =>
  projection?.units.filter(
    (unit) => unit.content._tag === "Entry" && unit.content.role === "assistant" && unit.content.text === answer,
  ) ?? []

test(
  "finalizes provider responses with redacted headers and cold-loads them without another model call",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-final-stream-hydration-" })

        yield* Effect.scoped(
          Effect.gen(function* () {
            const app = yield* TuiApp.tuiApp({
              root,
              inspectTranscript: true,
              lanes: [{ steps: [model.text(answer)], providerHttpEnvelope: envelope }],
            })
            yield* Effect.promise(() => app.type("Finish this response."))
            app.pressEnter()
            yield* app.waitFrame(answer)
            const live = yield* app.settled
            expect(live).toContain(answer)
            expect(live).not.toContain("Streaming")
            expect(live).not.toContain("Execution failed")
            const completed = yield* app.waitTranscript(turnId, (projection) => projection.state.status === "completed")
            expect(assistantAnswers(completed)).toHaveLength(1)
            expect(yield* app.modelRequestCount).toBe(1)
            expect(yield* app.modelProviderHttpEnvelopeCounts).toEqual({ request: 1, response: 1 })
            yield* app.quit
          }),
        )

        yield* Effect.scoped(
          Effect.gen(function* () {
            const app = yield* TuiApp.tuiApp({
              root,
              initialThreadId: "tui-thread-0",
              idStart: 10,
              inspectTranscript: true,
              lanes: [{ steps: [], providerHttpEnvelope: envelope }],
            })
            const frame = yield* app.waitFrame(answer)
            expect(frame.match(/FINAL_STREAM_HYDRATED/gu) ?? []).toHaveLength(1)
            expect(frame).not.toContain("Streaming")
            expect(frame).not.toContain("Execution failed")
            const completed = yield* app.waitTranscript(turnId, (projection) => projection.state.status === "completed")
            expect(assistantAnswers(completed)).toHaveLength(1)
            expect(yield* app.modelRequestCount).toBe(0)
            expect(yield* app.modelProviderHttpEnvelopeCounts).toEqual({ request: 0, response: 0 })
            yield* app.quit
          }),
        )

        const database = new Database(path.join(root, "baton.db"), { readonly: true })
        const payloads = database
          .query<
            { payload_json: string },
            []
          >("SELECT payload_json FROM baton_session_entries WHERE session_id = 'tui-thread-0' AND tag = 'ModelResponse'")
          .all()
        database.close()
        expect(payloads).toHaveLength(1)
        expect(payloads[0]?.payload_json).toContain(answer)
        expect(payloads[0]?.payload_json).not.toContain(requestUrl)
        expect(payloads[0]?.payload_json).not.toContain(responseRequestId)
        expect(payloads[0]?.payload_json).not.toContain(requestCanary)
        expect(payloads[0]?.payload_json).not.toContain(responseCanary)

        const databaseFiles = (yield* fileSystem.readDirectory(root)).filter(
          (name) => name === "baton.db" || name.startsWith("baton.db-"),
        )
        expect(databaseFiles.length).toBeGreaterThan(0)
        const image = Buffer.concat(
          yield* Effect.forEach(databaseFiles, (name) =>
            fileSystem.readFile(path.join(root, name)).pipe(Effect.map((bytes) => Buffer.from(bytes))),
          ),
        )
        expect(image.includes(Buffer.from(answer))).toBe(true)
        expect(image.includes(Buffer.from(requestUrl))).toBe(false)
        expect(image.includes(Buffer.from(responseRequestId))).toBe(false)
        expect(image.includes(Buffer.from(requestCanary))).toBe(false)
        expect(image.includes(Buffer.from(responseCanary))).toBe(false)
      }),
    ),
  tuiTestTimeout,
)
