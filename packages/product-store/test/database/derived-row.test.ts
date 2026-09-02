import { expect, it } from "@effect/vitest"
import { Effect, Logger, References, Schema } from "effect"
import { decodeDerivedRow } from "../../src/database/derived-row"
import { provideLayer } from "../turn/postgres/repository-layer.harness"

const Row = Schema.TaggedStruct("Current", { value: Schema.Finite })

interface CapturedLog {
  readonly level: string
  readonly message: string
  readonly annotations: ReadonlyArray<readonly [key: string, value: string]>
}

const annotation = (log: CapturedLog, key: string) => log.annotations.find(([name]) => name === key)?.[1]

const capture = (logs: Array<CapturedLog>) =>
  Logger.layer([
    Logger.make(({ logLevel, message, fiber }) => {
      logs.push({
        level: logLevel,
        message: String(message),
        annotations: Object.entries(fiber.getRef(References.CurrentLogAnnotations)).map(
          ([key, value]) => [key, String(value)] as const,
        ),
      })
    }),
  ])

it.effect("returns the decoded row and stays silent when the contract still matches", () =>
  Effect.gen(function* () {
    const logs: Array<CapturedLog> = []
    const decoded = yield* decodeDerivedRow({
      schema: Row,
      event: "test.row-undecodable",
      value: { _tag: "Current", value: 1 },
      annotations: [["rika.test.id", "row"]],
    }).pipe(provideLayer(capture(logs)))
    expect(decoded).toEqual({ _tag: "Current", value: 1 })
    expect(logs).toEqual([])
  }),
)

it.effect("drops a row the contract no longer decodes and reports it with its annotations", () =>
  Effect.gen(function* () {
    const logs: Array<CapturedLog> = []
    const decoded = yield* decodeDerivedRow({
      schema: Row,
      event: "test.row-undecodable",
      value: { _tag: "Legacy", value: 1 },
      annotations: [["rika.test.id", "row"]],
    }).pipe(provideLayer(capture(logs)))
    expect(decoded).toBeUndefined()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ level: "Warn", message: "test.row-undecodable" })
    expect(annotation(logs[0]!, "rika.test.id")).toBe("row")
    expect(annotation(logs[0]!, "rika.error.message")).toContain(`at ["_tag"]`)
  }),
)
