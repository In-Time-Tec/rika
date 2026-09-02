import { describe, expect, it } from "@effect/vitest"
import { Effect, Logger } from "effect"
import { GatewayTestHarness } from "./fixture"

const { encodeUnknown, makeGateway, milestone, socket, controller, access } = GatewayTestHarness

describe("executor gateway: undecodable frames", () => {
  it.effect("names the frame and schema issue before closing a peer speaking an older protocol", () =>
    Effect.gen(function* () {
      const observability: Array<ReturnType<typeof Logger.formatStructured.log>> = []
      const target = socket()
      const gateway = yield* makeGateway(controller())
      // The pre-native-tools Executor image reported tool results with this removed envelope.
      const legacyFrame = encodeUnknown({
        _tag: "CellResult",
        access,
        operationKey: "operation-1",
        attempt: 0,
        response: { _tag: "CellCompleted", output: "done" },
      })
      yield* gateway
        .receive(target, legacyFrame)
        .pipe(
          Effect.provideService(
            Logger.CurrentLoggers,
            new Set([Logger.map(Logger.formatStructured, (record) => observability.push(record))]),
          ),
        )
      expect(target.closed).toEqual([[1007, "undecodable CellResult frame; peer protocol does not match"]])
      const records = milestone(observability, "gateway.frame-undecodable")
      expect(records).toHaveLength(1)
      expect(records[0]!.level).toBe("ERROR")
      expect(records[0]!.annotations).toMatchObject({
        "rika.websocket.kind": "executor",
        "rika.frame.tag": "CellResult",
        "rika.frame.bytes": legacyFrame.length,
      })
      expect(String(records[0]!.annotations["rika.error.message"])).toMatch(
        /^Expected \{ readonly "_tag": "ExecutorHello"[\s\S]{0,470}$/,
      )
    }),
  )
})
