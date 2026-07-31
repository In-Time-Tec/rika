import * as ProductAgent from "../../agent/product-agent-service"
import * as ExecutionBackend from "../../execution/contract/execution-service"
import * as Thread from "../../thread/model/thread-record"
import * as ThreadRepository from "../../thread/repository/thread-repository"
import * as Turn from "../../thread/model/turn-record"
import * as TurnRepository from "../../thread/repository/turn-repository"
import * as ThreadSummaryRepository from "../../thread/repository/thread-summary-repository"
import * as TranscriptRepository from "../../thread/repository/transcript-repository"
import * as UsageRepository from "../../thread/repository/usage-repository"
import * as ThreadInteractionRepository from "../../thread/repository/thread-interaction-repository"
import * as ResolvedContext from "../../context/context-resolution-service"
import * as ExecutionExtensions from "@rika/extensions/execution-extension-service"
import * as ToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import { Input } from "../contract/product-operation"
import { OperationUnavailable } from "../contract/product-operation-service"
import { OperationError } from "../operation-error"
import { Clock, Console, Effect, Fiber, Layer } from "effect"

export interface Dependencies {
  readonly defaultWorkspace: string
  readonly pendingTurnCapacity: number
  readonly makeThreadId: Effect.Effect<Thread.ThreadId>
  readonly makeTurnId: Effect.Effect<Turn.TurnId>
  readonly resolveExecutionRoute: (mode: "medium", tuning?: undefined, workspace?: string) => Effect.Effect<Turn.ExecutionRoutePin, unknown, never>
  readonly toolRuntimeLayer: (workspace: string) => Layer.Layer<ToolRuntime.Service, OperationError, never>
  readonly productAgentLayer: Layer.Layer<ProductAgent.Service, OperationError, ExecutionBackend.Service> | undefined
  readonly backendLayer: Layer.Layer<ExecutionBackend.Service, unknown, never>
  readonly acquiredDependencies: Layer.Layer<
    | ThreadRepository.Service
    | TurnRepository.Service
    | ThreadSummaryRepository.Service
    | TranscriptRepository.Service
    | UsageRepository.Service
    | ThreadInteractionRepository.Service
    | ResolvedContext.Service
    | ExecutionExtensions.ExecutionExtensionService,
    never,
    never
  >
  readonly createObservedSubmission: (turns: TurnRepository.Interface, input: TurnRepository.CreateInput) => Effect.Effect<{ readonly turn: Turn.Turn; readonly claimed: boolean }, unknown, never>
  readonly ensureTurnSummary: (turn: Turn.Turn) => Effect.Effect<void, unknown, never>
  readonly setTurnStatus: (id: Turn.TurnId, status: Turn.Status, cursor: string | undefined, now: number) => Effect.Effect<Turn.Turn, unknown, never>
  readonly startReviewSettlement: (turn: Pick<Turn.AgentExecutionTurn, "id" | "lastCursor">, fanOutId: string, initial?: ExecutionBackend.FanOutInspection) => Effect.Effect<Fiber.Fiber<ExecutionBackend.FanOutInspection, OperationError>, unknown, never>
  readonly releaseTurnObserver: (turnId: Turn.TurnId) => Effect.Effect<unknown, never, never>
  readonly encodeJson: (value: unknown) => string
  readonly operationError: (message: string) => Effect.Effect<never, OperationError>
  readonly unavailable: (input: Input, message: string) => OperationUnavailable
}

export const run = Effect.fn("ReviewOperation.run")(function* (input: Extract<Input, { readonly _tag: "Review" }>, dependencies: Dependencies) {

  if (dependencies.toolRuntimeLayer === undefined)
    return yield* dependencies.unavailable(input, "Review requires the local tool runtime")
  const workspace = input.workspace ?? dependencies.defaultWorkspace
  const program = Effect.gen(function* () {
    const tools = yield* ToolRuntime.Service
    const agents = yield* ProductAgent.Service
    if (input.staged && input.base !== undefined)
      return yield* dependencies.operationError("Review cannot combine --staged with --base")
    if (input.base !== undefined && (input.base.length === 0 || input.base.startsWith("-")))
      return yield* dependencies.operationError("Review --base must name a Git revision")
    const args = ["diff", "--no-ext-diff", "--no-color"]
    if (input.staged) args.push("--cached")
    else if (input.base !== undefined) args.push("--end-of-options", `${input.base}...HEAD`)
    if (input.paths.length > 0) args.push("--", ...input.paths)
    const diffResult = yield* tools.run({ _tag: "Shell", command: "git", args, waitMillis: 120_000 })
    if (diffResult.exitCode === undefined)
      return yield* dependencies.operationError("Git diff did not finish before the review timeout")
    if (diffResult.exitCode !== 0) return yield* dependencies.operationError(diffResult.text || "Git diff failed")
    if (diffResult.truncated) return yield* dependencies.operationError("Git diff exceeded the review output limit")
    const diff = diffResult.text.trim()
    if (diff.length === 0) {
      yield* Console.log(
        input.json ? dependencies.encodeJson({ status: "no-changes", findings: [] }) : "No changes to review.",
      )
      return
    }
    const now = yield* Clock.currentTimeMillis
    const threads = yield* ThreadRepository.Service
    const turns = yield* TurnRepository.Service
    const thread = yield* threads.create({
      id: yield* dependencies.makeThreadId,
      workspace,
      title: "Code review",
      now,
    })
    const parentTurnId = yield* dependencies.makeTurnId
    const executionRoute = yield* dependencies.resolveExecutionRoute("medium", undefined, thread.workspace)
    const fanOutId = `review:${parentTurnId}`
    const focus = [
      ["correctness", "Find correctness defects, regressions, and edge cases."],
      ["security", "Find security, privacy, and unsafe-input defects."],
      ["quality", "Find missing tests, maintainability risks, and contract violations."],
    ] as const
    let reviewObserverClaimed = false
    const settled = yield* Effect.gen(function* () {
      const settlement = yield* Effect.gen(function* () {
        const observed = yield* dependencies.createObservedSubmission(turns, {
          id: parentTurnId,
          threadId: thread.id,
          prompt: "Review workspace changes",
          executionRoute,
          reviewFanOutId: fanOutId,
          queueCapacity: dependencies.pendingTurnCapacity,
          now,
        })
        const parentTurn = observed.turn
        if (!observed.claimed)
          return yield* dependencies.operationError(`Turn ${parentTurn.id} already has an execution observer`)
        reviewObserverClaimed = true
        yield* dependencies.ensureTurnSummary(parentTurn)
        const runningParentTurn = yield* dependencies.setTurnStatus(parentTurnId, "running", undefined, now)
        const inspection = yield* agents.runReviewLanes({
          parentTurnId,
          fanOutId,
          workspace: thread.workspace,
          executionRoute,
          checks: focus.map(([id, instruction]) => ({
            id: `${fanOutId}:${id}`,
            prompt: `${instruction}\nReturn concise actionable findings with file and line references. If none, say no findings.\n\n${diff}`,
          })),
          maxConcurrency: focus.length,
          join: "best-effort",
          createdAt: now,
        })
        return yield* dependencies.startReviewSettlement(runningParentTurn, fanOutId, inspection)
      }).pipe(
        Effect.catch((error) =>
          dependencies.setTurnStatus(parentTurnId, "failed", undefined, now).pipe(Effect.andThen(Effect.fail(error))),
        ),
        Effect.uninterruptible,
      )
      return yield* Fiber.join(settlement)
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          reviewObserverClaimed ? dependencies.releaseTurnObserver(parentTurnId).pipe(Effect.asVoid) : Effect.void,
        ),
      ),
    )
    const lanes = agents.projectChildren(settled).map((lane) => ({
      id: lane.childId.slice(fanOutId.length + 1),
      status: lane.state,
      output: lane.output,
      error: lane.error,
    }))
    if (settled.state === "failed" || lanes.every((lane) => lane.status !== "completed"))
      return yield* dependencies.operationError(
        lanes
          .map((lane) => lane.error)
          .filter((error): error is string => error !== undefined && error.length > 0)
          .join("; ") || "Review failed",
      )
    if (input.json) {
      yield* Console.log(dependencies.encodeJson({ status: settled.state, lanes }))
      return
    }
    yield* Console.log(
      lanes
        .map((lane) => {
          if (lane.output === undefined) {
            return `## ${lane.id}\nReview lane ${lane.status}${
              lane.error === undefined ? "" : `: ${lane.error}`
            }`
          }
          const output = typeof lane.output === "string" ? lane.output : dependencies.encodeJson(lane.output)
          return `## ${lane.id}\n${output}`
        })
        .join("\n\n"),
    )
  })
  const agentLayer = dependencies.productAgentLayer ?? ProductAgent.layer
  const reviewToolRuntimeLayer = dependencies.toolRuntimeLayer(workspace)
  yield* Effect.gen(function* () {
    const reviewContext = yield* Layer.build(
      Layer.mergeAll(
        reviewToolRuntimeLayer,
        agentLayer.pipe(Layer.provide(dependencies.backendLayer)),
        dependencies.backendLayer,
        dependencies.acquiredDependencies,
      ),
    ).pipe(Effect.mapError((error) => dependencies.unavailable(input, String(error))))
    yield* program.pipe(
      Effect.provide(reviewContext),
      Effect.mapError((error) => dependencies.unavailable(input, error instanceof Error ? error.message : String(error))),
    )
  }).pipe(Effect.scoped)
})
