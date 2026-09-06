import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import * as HostedPostgres from "@rika/product-store/layer"
import { runnerProtocolVersion } from "@rika/product/runner-registration"
import { Effect, Fiber, Layer, Redacted } from "effect"
import { GatewayError } from "../../../src/executor/gateway"
import { access, authority, decode, encode, live, makeRunnerGateway, socket, toolRequest } from "./harness"
import { eventually, isolated, seed } from "./database.harness"

it.effect.skipIf(!live)("publishes a completed process observation before acknowledging and heals on duplicate", () =>
  isolated(({ url, databaseClient }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const operationKey = "native-tool-process-observation"
        const request = toolRequest(operationKey)
        yield* seed(databaseClient, operationKey, { request, state: "accepted" })
        let publications = 0
        const publish = () =>
          Effect.sync(() => ++publications).pipe(
            Effect.flatMap((attempt) =>
              attempt === 1
                ? Effect.fail(GatewayError.make({ kind: "transport", message: "publication unavailable" }))
                : Effect.void,
            ),
          )
        const context = yield* Layer.build(
          Layer.merge(HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 }), BunCrypto.layer),
        )
        const gateway = yield* makeRunnerGateway(authority(), publish).pipe(Effect.provide(context))
        const target = socket()
        yield* gateway.receive(
          target,
          encode({ _tag: "ExecutorReconnect", protocolVersion: runnerProtocolVersion, access }),
        )
        const running = yield* Effect.forkChild(gateway.execute(request))
        const delivery = yield* eventually(() =>
          target.sent
            .map((frame) => decode(frame))
            .find((message) => message._tag === "MachineExecute" && message.operationKey === operationKey),
        )
        if (delivery._tag !== "MachineExecute") return yield* Effect.die("native machine request was not sent")
        yield* gateway.receive(
          target,
          encode({
            _tag: "MachineResult",
            access,
            operationKey,
            attempt: delivery.attempt,
            machineId: delivery.machineId,
            requestDigest: delivery.requestDigest,
            outcome: {
              _tag: "Success",
              value: {
                _tag: "NativeTool",
                result: { text: "running", truncated: false, running: true, processId: "process-1" },
              },
            },
          }),
        )
        yield* Fiber.join(running)
        const observation = {
          _tag: "ProcessObservation" as const,
          access,
          operationKey,
          attempt: delivery.attempt,
          machineId: delivery.machineId,
          requestDigest: delivery.requestDigest,
          observation: { processId: "process-1", exitCode: 0, elapsedMillis: 1000, truncated: false },
        }
        yield* gateway.receive(target, encode(observation))
        expect(publications).toBe(1)
        expect(
          target.sent.map((frame) => decode(frame)).filter((message) => message._tag === "ProcessObservationAck"),
        ).toHaveLength(0)

        yield* gateway.receive(target, encode(observation))
        expect(publications).toBe(2)
        expect(
          target.sent.map((frame) => decode(frame)).filter((message) => message._tag === "ProcessObservationAck"),
        ).toEqual([{ _tag: "ProcessObservationAck", machineId: delivery.machineId, processId: "process-1" }])
      }),
    ),
  ),
)
