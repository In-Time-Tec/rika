import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Agent, AgentManifest, ExecutableManifest, Pins } from "tenetkit"
import { ExecutableRegistration, ExecutableResolver, ExecutionHost, Runtime, RunStore } from "tenetkit/runtime"
import { Effect, Fiber, Layer, Schema, Stream } from "effect"
import { LanguageModel, Response } from "effect/unstable/ai"
import { Command } from "effect/unstable/cli"
import { fullEvidence, sqlAccounting } from "./semantic-output/database-evidence"
import { HostFiles } from "./semantic-output/host-files"
import { assertSafe, make as makeIsolation } from "./semantic-output/isolation"
import { sample as sampleProcessTree } from "./semantic-output/process-tree"
import type { Sample } from "./semantic-output/contract"
import { makeWorkerCommand, type WorkerOptions } from "./semantic-output/worker-cli"
import { fragments } from "./semantic-output/workload"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

const execute = (options: WorkerOptions) =>
  Effect.gen(function* () {
    const source = options.source
    const caseName = options.case
    const sampleNumber = options.sample
    const warmup = options.warmup
    const isolation = makeIsolation(options.root)
    assertSafe({ isolation, ...(Bun.env.HOME === undefined ? {} : { userHome: Bun.env.HOME }) })
    for (const path of [isolation.cwd, isolation.home, isolation.temporary]) HostFiles.mkdir(path)
    process.chdir(isolation.cwd)
    if (Bun.env.HOME !== isolation.home || Bun.env.TMPDIR !== isolation.temporary)
      throw new Error("worker HOME and TMPDIR must be set by the orchestrator before startup")
    if (Bun.env.RIKA_TENETKIT_DATABASE !== isolation.tenetkitDatabase)
      throw new Error("worker TenetKit database environment does not match its explicit database")

    const responseUsage = Response.Usage.make({
      inputTokens: { total: 7, uncached: 7, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 250_000, text: 250_000, reasoning: 0 },
    })
    const finish = Response.makePart("finish", { reason: "stop", usage: responseUsage, response: undefined })
    const values = fragments(caseName)
    let peakHeapBytes = process.memoryUsage().heapUsed
    let peakProcessTreeRssBytes = sampleProcessTree()
    let terminalFinishes = 0

    const stream = () => {
      let fragmentIndex = 0
      const deltas = Stream.fromIterable(values).pipe(
        Stream.mapEffect((delta) => {
          fragmentIndex += 1
          peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed)
          if (fragmentIndex % 320 === 0) {
            const measured = sampleProcessTree()
            if (measured !== undefined)
              peakProcessTreeRssBytes = Math.max(peakProcessTreeRssBytes ?? measured, measured)
          }
          const part = Response.makePart("text-delta", { id: "semantic-text", delta })
          if (fragmentIndex % 32 !== 0) return Effect.succeed(part)
          return Effect.yieldNow.pipe(Effect.as(part))
        }),
      )
      const boundary = Stream.make(Response.makePart("text-start", { id: "semantic-text" })).pipe(
        Stream.concat(deltas),
        Stream.concat(Stream.make(Response.makePart("text-end", { id: "semantic-text" }))),
        Stream.concat(
          Stream.fromEffect(
            Effect.sync(() => {
              terminalFinishes += 1
              return finish
            }),
          ),
        ),
      )
      return boundary
    }

    const agent = Agent.make({ name: "semantic-output-benchmark" })
    const modelPin = Pins.makeModel({ fixture: "semantic-output", revision: "1" })
    const pinned = AgentManifest.fromLiveAgent(agent, {
      model: modelPin,
      tools: [],
      skills: [],
      services: [],
      policy: { _tag: "Portable", policy: agent.policy.snapshot! },
      budget: agent.budget ?? {},
      children: [],
    })
    const executable = ExecutableManifest.make({ root: pinned.pin, entries: [{ _tag: "Agent", ...pinned }] })
    const registrations = [...ExecutableRegistration.requiredPins(executable)].map((pin) => ({
      pin,
      codec: "semantic-output-benchmark",
      version: "1",
      payload: { fixture: "semantic-output" },
    }))
    const model = Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.make({ generateText: () => Effect.succeed([]), streamText: stream }),
    )
    const resolver = ExecutableResolver.makeStatic([{ executable, agent: Agent.close(agent, model) }])
    const runtimeLayer = Runtime.layerSqlite({
      filename: isolation.tenetkitDatabase,
      resolver,
      addresses: [],
      subscriberQueueCapacity: 1_024,
      scheduler: { pollInterval: "1 day" },
    })

    const started = process.hrtime.bigint()
    const cpuStarted = process.cpuUsage()
    let firstResponseAt: bigint | undefined
    let firstResponseKind = "unsupported"
    const result = yield* Effect.scoped(
      Effect.flatMap(Layer.build(runtimeLayer), (context) =>
        Effect.gen(function* () {
          const runtime = yield* Runtime.Runtime
          const receipt = yield* runtime.start({
            executable,
            registrations,
            sessionId: "semantic-session",
            idempotencyKey: "semantic-turn",
            prompt: "Produce the benchmark payload.",
          })
          const candidateRuntime = runtime as typeof runtime & {
            readonly previews?: (input: { readonly runId: string }) => Stream.Stream<unknown>
          }
          const first =
            candidateRuntime.previews === undefined
              ? runtime.events({ runId: receipt.runId }).pipe(Stream.filter((event) => event._tag === "ModelPart"))
              : candidateRuntime.previews({ runId: receipt.runId })
          firstResponseKind = candidateRuntime.previews === undefined ? "durable-model-part" : "model-preview"
          const subscriber = yield* first.pipe(
            Stream.take(1),
            Stream.runForEach(() =>
              Effect.sync(() => {
                firstResponseAt ??= process.hrtime.bigint()
              }),
            ),
            Effect.forkScoped,
          )
          const store = yield* RunStore.RunStore
          const host = yield* ExecutionHost.ExecutionHost
          yield* host.execute(yield* store.claimExecution({ runId: receipt.runId, ownerId: "semantic-worker" }))
          yield* Fiber.interrupt(subscriber)
          return yield* runtime.snapshot(receipt.runId)
        }).pipe(Effect.provideContext(context)),
      ),
    )
    const completed = process.hrtime.bigint()
    const cpu = process.cpuUsage(cpuStarted)
    peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed)
    Bun.gc(true)
    yield* Effect.sleep(25)
    const postGcHeapBytes = process.memoryUsage().heapUsed
    const postGcProcessTreeRssBytes = sampleProcessTree()
    if (postGcProcessTreeRssBytes !== undefined)
      peakProcessTreeRssBytes = Math.max(
        peakProcessTreeRssBytes ?? postGcProcessTreeRssBytes,
        postGcProcessTreeRssBytes,
      )

    if (result.outcome?._tag !== "Succeeded" || !("text" in result.outcome.result))
      throw new Error(`TenetKit Run did not succeed with text: ${encodeJson(result.outcome)}`)
    const text = result.outcome.result.text
    const tenetkitSql = sqlAccounting(isolation.tenetkitDatabase)
    const identityFile = options.identity
    const identity = decodeJson(HostFiles.read(identityFile)) as Record<string, unknown>
    const resolvedCore = import.meta.resolve("tenetkit")
    const resolvedRuntime = import.meta.resolve("tenetkit/runtime")
    const manifestAt = (resolved: string) => {
      const packageRoot = HostFiles.dirname(HostFiles.dirname(new URL(resolved).pathname))
      return JSON.parse(HostFiles.read(HostFiles.join(packageRoot, "package.json"))) as {
        readonly name: string
        readonly version: string
      }
    }
    const coreManifest = manifestAt(resolvedCore)
    const runtimeManifest = manifestAt(resolvedRuntime)
    const wallMilliseconds = Number(completed - started) / 1_000_000
    const heapStats =
      (Bun as unknown as { readonly heapStats?: () => Readonly<Record<string, unknown>> }).heapStats?.() ?? {}
    const output: Sample = {
      schemaVersion: 1,
      source,
      mode: "tenetkit",
      case: caseName,
      sample: sampleNumber,
      warmup,
      output: {
        bytes: Buffer.byteLength(text),
        sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"),
      },
      correctness: {
        durableModelParts: tenetkitSql.modelPartEvents,
        modelResponsesCommitted: tenetkitSql.modelResponseCommittedEvents,
        terminalFinishes,
      },
      timing: {
        wallMilliseconds,
        cpuMilliseconds: (cpu.user + cpu.system) / 1_000,
        ...(firstResponseAt === undefined
          ? {}
          : { firstPreviewMilliseconds: Number(firstResponseAt - started) / 1_000_000 }),
        completionMilliseconds: wallMilliseconds,
      },
      memory: {
        peakHeapBytes,
        postGcHeapBytes,
        ...(peakProcessTreeRssBytes === undefined ? {} : { peakProcessTreeRssBytes }),
        ...(postGcProcessTreeRssBytes === undefined ? {} : { postGcProcessTreeRssBytes }),
        bunHeapStats: Object.fromEntries(
          Object.entries(heapStats).flatMap(([key, value]) => (typeof value === "number" ? [[key, value]] : [])),
        ),
        allocatorRelief: {
          status: "unsupported",
          detail: "Bun.gc(true) supplies full GC but Bun exposes no portable allocator purge operation.",
        },
      },
      tenetkitSql,
      projection: { commitProjectionCalls: 0 },
      databases: fullEvidence(isolation.tenetkitDatabase),
      identity: {
        ...identity,
        firstResponseKind,
        controlAck: { status: "unsupported", detail: "The payload-only workload issues no Runtime control command." },
        worker: {
          bun: Bun.version,
          pid: process.pid,
          cwd: process.cwd(),
          home: Bun.env.HOME,
          tmpdir: Bun.env.TMPDIR,
        },
        packages: {
          core: { ...coreManifest, resolved: resolvedCore },
          runtime: { ...runtimeManifest, resolved: resolvedRuntime },
        },
        transport: {
          implementation: "LanguageModel.make",
          testModelPartsUsed: false,
          textPartId: "semantic-text",
          finishReason: "stop",
          usage: responseUsage,
          yieldEveryFragments: 32,
          processTreeRssSampling: "startup, every 320 fragments, post-GC",
        },
      },
    }
    process.stdout.write(`${encodeJson(output)}\n`)
  })

const command = makeWorkerCommand(execute)
const main = Command.run(command, { version: "0.0.0" }).pipe(Effect.orDie)

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(
      Effect.flatMap(Layer.build(BunServices.layer.pipe(Layer.orDie)), (context) => Effect.provide(main, context)),
    ),
  )
