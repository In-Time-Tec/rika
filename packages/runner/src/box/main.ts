import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { BoxBootstrapDocument, maxBootstrapDocumentBytes } from "@rika/box-executor/bootstrap"
import type { BoxWorkspaceInputReceipt } from "@rika/box-executor/workspace-input-contract"
import { Effect, Layer, Schema, Stdio, Stream } from "effect"

import {
  runBoxExecutor,
  type BoxExecutorExpected,
  type BoxExecutorFailure,
  type BoxExecutorOptions,
  type BoxExecutorRequirements,
} from "./daemon"
import {
  runWorkspaceInput,
  type BoxWorkspaceInputModeError,
  type BoxWorkspaceInputOptions,
  type BoxWorkspaceInputRequirements,
} from "./workspace-input"

export interface BoxExecutorMainOptions {
  readonly expected: BoxExecutorExpected
  readonly connect: BoxExecutorOptions["connect"]
  readonly workspaceInput?: BoxWorkspaceInputOptions
}

export class BoxExecutorMainError extends Schema.TaggedError<BoxExecutorMainError>()(
  "RikaRunnerV2BoxExecutorMainError",
  {
    kind: Schema.Literals(["input", "timeout"]),
    message: Schema.String,
  },
) {}

export type BoxExecutorMainFailure = BoxExecutorMainError | BoxWorkspaceInputModeError | BoxExecutorFailure
export type BoxExecutorMainRequirements = Stdio.Stdio | BoxExecutorRequirements | BoxWorkspaceInputRequirements

const inputFailure = (kind: BoxExecutorMainError["kind"]) =>
  BoxExecutorMainError.make({
    kind,
    message: kind === "timeout" ? "Box bootstrap input timed out" : "Box bootstrap input is invalid",
  })

const readBootstrapDocument = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  if (args.length !== 2 || args[0] !== "box" || args[1] !== "--bootstrap-stdin") return yield* inputFailure("input")
  const chunks: Array<Uint8Array> = []
  let total = 0
  yield* Stream.runForEach(stdio.stdin, (chunk) => {
    if (chunk.byteLength > maxBootstrapDocumentBytes - total) return Effect.fail(inputFailure("input"))
    return Effect.sync(() => {
      chunks.push(chunk)
      total += chunk.byteLength
    })
  }).pipe(
    Effect.mapError(() => inputFailure("input")),
    Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.fail(inputFailure("timeout")) }),
  )
  if (total === 0) return yield* inputFailure("input")
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: () => inputFailure("input"),
  })
  return yield* Schema.decodeEffect(Schema.fromJsonString(BoxBootstrapDocument))(text).pipe(
    Effect.mapError(() => inputFailure("input")),
  )
})

export const runBoxExecutorMain = (
  options: BoxExecutorMainOptions,
): Effect.Effect<BoxWorkspaceInputReceipt, BoxExecutorMainFailure, BoxExecutorMainRequirements> =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    const args = yield* stdio.args
    if (args.length === 2 && args[0] === "workspace-input" && args[1] === "--stdin")
      return yield* runWorkspaceInput(options.workspaceInput)
    return yield* readBootstrapDocument.pipe(
      Effect.flatMap((bootstrap) =>
        runBoxExecutor({ bootstrap, expected: options.expected, connect: options.connect }),
      ),
    )
  })

export const runBoxExecutorProcess = (options: BoxExecutorMainOptions): void =>
  BunRuntime.runMain(
    Effect.scoped(
      Layer.build(BunServices.layer).pipe(
        Effect.flatMap((context) => Effect.provide(runBoxExecutorMain(options), context)),
      ),
    ),
  )
