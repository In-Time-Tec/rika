import { expect, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { ToolContext, ToolExecutor } from "tenetkit"
import { CellTool, KernelPool, KernelProfile, TestKernel } from "tenetkit/repl"
import * as ExecutorRuntime from "@rika/kernel/executor-runtime"
import { configure } from "@rika/execution/route"
import * as ExecutionPins from "@rika/kernel/execution-pins"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import { Context, Effect, FileSystem, Function, Layer } from "effect"
import { Response } from "effect/unstable/ai"
import * as Kernel from "../../../support/kernel-layer.harness"
import { GoalService, layer as goalServiceLayer } from "@rika/product/goal-service"
import * as GoalRepository from "@rika/product/goal-repository"
import * as ThreadQuery from "@rika/product/thread-query-service"
import * as CodingToolRuntime from "@rika/coding-tools/coding-tool-runtime"

const kernel = { runtimeVersion: Bun.version, dataRoot: "/tmp/rika-kernel-wiring" } as const

const provideLayer: {
  <RIn, E2, ROut>(
    layer: Layer.Layer<ROut, E2, RIn>,
  ): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | E2, RIn | Exclude<R, ROut>>
  <A, E, R, RIn, E2, ROut>(
    effect: Effect.Effect<A, E, R>,
    layer: Layer.Layer<ROut, E2, RIn>,
  ): Effect.Effect<A, E | E2, RIn | Exclude<R, ROut>>
} = Function.dual(2, <A, E, R, RIn, E2, ROut>(effect: Effect.Effect<A, E, R>, layer: Layer.Layer<ROut, E2, RIn>) =>
  Effect.scoped(Effect.flatMap(Layer.build(layer), (context) => Effect.provide(effect, context))),
)

const temporaryRoots = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-kernel-wiring-" })
  return { home, workspace: `${home}/repo`, dataRoot: `${home}/.rika` }
})

const kernelOptions = (roots: { home: string; workspace: string; dataRoot: string }) => ({
  workspace: roots.workspace,
  home: roots.home,
  dataRoot: roots.dataRoot,
  runtimeVersion: Bun.version,
  goalRepositoryLayer: GoalRepository.memoryLayer,
  queryFactory: Layer.succeed(ThreadQuery.Factory, ThreadQuery.Factory.of({ forWorkspace: () => Effect.never })),
  toolRuntimeLayer: Layer.succeed(CodingToolRuntime.Service, CodingToolRuntime.Service.of({ run: () => Effect.never })),
})

const cellRequest = (code: string, sessionId: string): ToolExecutor.Request => {
  const call = Response.makePart("tool-call", {
    id: "call-1",
    name: CellTool.name,
    params: { code },
    providerExecuted: false,
  })
  return { call, toolCallBatch: { calls: [call] }, turn: 0, toolCallIndex: 0, agentName: "rika-root", sessionId }
}

const cellContext = (sessionId: string) =>
  Effect.map(
    Effect.abortSignal,
    (signal): ToolContext.Interface => ({
      signal,
      emit: () => Effect.void,
      sessionId,
      runId: `run-${sessionId}`,
      toolCallId: `call-${sessionId}`,
      operationKey: `operation-${sessionId}`,
    }),
  )

it.effect("mounts the rika surface as a dependency of the pool, so a cell can reach it", () =>
  Effect.gen(function* () {
    const roots = yield* temporaryRoots
    const layer = Kernel.layer(kernelOptions(roots))
    const built = yield* Layer.build(layer)
    // Both halves are present: the pool a cell runs in, and the per-call identity seam.
    expect(Context.get(built, KernelPool.KernelPool)).toBeDefined()
    expect(Context.get(built, ExecutorRuntime.CellContext)).toBeDefined()
  }).pipe(provideLayer(BunServices.layer)),
)

it.effect("pins every discovered skill and the harness snapshot into the admitted manifest", () =>
  Effect.gen(function* () {
    const skills: ReadonlyArray<ExecutionPins.SkillPin> = [
      { name: "reviewer", digest: "digest-reviewer", importName: "@skills/reviewer" },
    ]
    const configured = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      kernel,
      skills,
    })
    const root = configured.profiles["Task"]!
    const pinnedSkills = root.manifest.skills.map((entry) => entry.name)
    expect(pinnedSkills).toContain("reviewer")
    // The skill registration travels with the executable, so a replay reconstructs the same set.
    const registered = configured.registrations.some((entry) => entry.codec === "rika-skill")
    expect(registered).toBe(true)
  }),
)

it.effect("routes an admitted cell through the pool the composition root supplied", () =>
  Effect.gen(function* () {
    const executed: Array<string> = []
    const pool = Layer.mergeAll(
      TestKernel.layerTestPool({
        profile: KernelProfile.make({
          runtime: { name: "bun", version: kernel.runtimeVersion, digest: "runtime-digest" },
          bindingsDigest: KernelProfile.bindingsDigest(["workspace"]),
          workspace: { root: "/workspace", dataRoot: kernel.dataRoot },
          limits: { sourceBytes: CellTool.maxSourceBytes, cellDeadlineMillis: 1_000 },
          trustMode: "trusted-local",
        }),
        script: (request) => {
          executed.push(request.code)
          return { _tag: "Value", value: `evaluated:${request.code}` }
        },
      }),
      ExecutorRuntime.cellContextLayer,
    )
    const configured = yield* configure({
      executionRoute: testExecutionRoute(),
      workspace: "/workspace",
      kernel,
      cell: { _tag: "Local", services: yield* Layer.build(pool) },
    })
    const entry = configured.resolverEntries.find(({ agent }) => agent.name === "rika-root")!
    const environment = entry.agent.open((_agent, agentEnvironment) => agentEnvironment)
    const context = yield* Layer.build(environment)
    const executor = Context.get(context, ToolExecutor.ToolExecutor)
    const outcome = yield* executor
      .execute(cellRequest("1 + 1", "session-a"))
      .pipe(Effect.provideServiceEffect(ToolContext.ToolContext, cellContext("session-a")))
    expect(outcome._tag).toBe("Success")
    expect(executed).toEqual(["1 + 1"])
  }).pipe(provideLayer(BunServices.layer)),
)

it.effect("a goal created for one Thread is never visible to another", () =>
  Effect.gen(function* () {
    const goals = yield* GoalService
    yield* goals.create({ threadId: "thread-a", objective: "ship the kernel", budget: {} })
    expect((yield* goals.get("thread-a"))?.objective).toBe("ship the kernel")
    expect(yield* goals.get("thread-b")).toBeUndefined()
  }).pipe(provideLayer(goalServiceLayer.pipe(Layer.provide(GoalRepository.memoryLayer)))),
)
