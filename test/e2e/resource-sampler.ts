import { Context, Effect, Fiber, FiberSet, Layer, Ref, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export class ResourceSamplingError extends Schema.TaggedErrorClass<ResourceSamplingError>()("ResourceSamplingError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface ResourceSample {
  readonly timestampMilliseconds: number
  readonly pid: number
  readonly rssKilobytes: number
  readonly cpuPercent: number
  readonly openFileDescriptors: number
  readonly openSockets: number
}

export interface ResourceSummary {
  readonly samples: number
  readonly peakRssKilobytes: number
  readonly meanRssKilobytes: number
  readonly meanCpuPercent: number
  readonly peakOpenFileDescriptors: number
  readonly peakOpenSockets: number
}

export interface OrphanProcess {
  readonly pid: number
  readonly parentPid: number
  readonly processGroupId: number
  readonly status: string
  readonly command: string
}

export interface ProcessCleanup {
  readonly detected: ReadonlyArray<OrphanProcess>
  readonly remaining: ReadonlyArray<OrphanProcess>
}

export interface ProcessResources {
  readonly pid: number
  readonly series: Effect.Effect<ReadonlyArray<ResourceSample>>
  readonly summary: Effect.Effect<ResourceSummary>
  readonly stop: Effect.Effect<void>
}

export interface Interface {
  readonly snapshot: (pid: number) => Effect.Effect<ResourceSample | undefined, ResourceSamplingError>
  readonly watch: (pid: number) => Effect.Effect<ProcessResources, ResourceSamplingError>
  readonly track: (pids: ReadonlyArray<number>) => Effect.Effect<void, ResourceSamplingError>
  readonly descendants: (
    pids: ReadonlyArray<number>,
  ) => Effect.Effect<ReadonlyArray<OrphanProcess>, ResourceSamplingError>
  readonly scanOrphans: Effect.Effect<ReadonlyArray<OrphanProcess>, ResourceSamplingError>
  readonly terminateOrphans: Effect.Effect<ProcessCleanup, ResourceSamplingError>
}

export class Service extends Context.Service<Service, Interface>()("rika/test/e2e/ResourceSampler") {}

const failure = (operation: string, cause: unknown) => ResourceSamplingError.make({ operation, message: String(cause) })

const mean = (values: ReadonlyArray<number>) =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length

export const summarize = (series: ReadonlyArray<ResourceSample>): ResourceSummary => ({
  samples: series.length,
  peakRssKilobytes: Math.max(0, ...series.map((sample) => sample.rssKilobytes)),
  meanRssKilobytes: mean(series.map((sample) => sample.rssKilobytes)),
  meanCpuPercent: mean(series.map((sample) => sample.cpuPercent)),
  peakOpenFileDescriptors: Math.max(0, ...series.map((sample) => sample.openFileDescriptors)),
  peakOpenSockets: Math.max(0, ...series.map((sample) => sample.openSockets)),
})

const parseProcessUsage = (output: string) => {
  const fields = output.trim().split(/\s+/)
  if (fields.length < 2) return undefined
  const rssKilobytes = Number(fields[0])
  const cpuPercent = Number(fields[1])
  return Number.isFinite(rssKilobytes) && Number.isFinite(cpuPercent) ? { rssKilobytes, cpuPercent } : undefined
}

const parseLsof = (output: string) => {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const entries = lines[0]?.startsWith("COMMAND") === true ? lines.slice(1) : lines
  return {
    openFileDescriptors: entries.length,
    openSockets: entries.filter((line) => /\s(?:IPv4|IPv6)\s|\s(?:TCP|UDP)\s/.test(line)).length,
  }
}

const parseOrphan = (output: string): OrphanProcess | undefined => {
  const matched = output.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)
  if (matched === null) return undefined
  return {
    pid: Number(matched[1]),
    parentPid: Number(matched[2]),
    processGroupId: Number(matched[3]),
    status: matched[4]!,
    command: matched[5]!,
  }
}

const parseProcessTable = (output: string) =>
  output
    .split("\n")
    .map(parseOrphan)
    .filter((entry): entry is OrphanProcess => entry !== undefined)

const isOwnProbe = (entry: OrphanProcess) =>
  entry.parentPid === process.pid && /^\(?(?:ps|pgrep|lsof)\)?$/.test(entry.command.split("/").at(-1) ?? "")

const descendantClosure = (processes: ReadonlyArray<OrphanProcess>, roots: ReadonlySet<number>) => {
  const related = new Set(roots)
  let changed = true
  while (changed) {
    changed = false
    for (const entry of processes) {
      if (related.has(entry.pid) || !related.has(entry.parentPid)) continue
      related.add(entry.pid)
      changed = true
    }
  }
  return related
}

export const layer = (options: { readonly intervalMilliseconds?: number } = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fibers = yield* FiberSet.make<void, ResourceSamplingError>()
      const interval = options.intervalMilliseconds ?? 100
      const output = Effect.fn("ResourceSampler.output")(function* (executable: string, args: ReadonlyArray<string>) {
        return yield* spawner
          .string(ChildProcess.make(executable, args, { stdin: "ignore", stderr: "ignore" }))
          .pipe(Effect.mapError((cause) => failure(`${executable} ${args.join(" ")}`, cause)))
      })
      const snapshot = Effect.fn("ResourceSampler.snapshot")(function* (pid: number) {
        const [usageOutput, lsofOutput, timestampMilliseconds] = yield* Effect.all(
          [
            output("ps", ["-o", "rss=,%cpu=", "-p", String(pid)]),
            output("lsof", ["-nP", "-p", String(pid)]),
            Effect.clockWith((clock) => clock.currentTimeMillis),
          ],
          { concurrency: 3 },
        )
        const usage = parseProcessUsage(usageOutput)
        if (usage === undefined) return undefined
        return {
          timestampMilliseconds,
          pid,
          ...usage,
          ...parseLsof(lsofOutput),
        } satisfies ResourceSample
      })
      const tracked = yield* Ref.make({
        pids: new Set<number>(),
        processGroupIds: new Set<number>(),
      })
      const processTable = output("ps", ["-axo", "pid=,ppid=,pgid=,stat=,comm="]).pipe(
        Effect.map(parseProcessTable),
        Effect.map((processes) => processes.filter((entry) => !isOwnProbe(entry))),
      )
      const capture = Effect.fn("ResourceSampler.capture")(function* () {
        const processes = yield* processTable
        const state = yield* Ref.get(tracked)
        const seeds = new Set([
          ...state.pids,
          ...processes.filter((entry) => state.processGroupIds.has(entry.processGroupId)).map((entry) => entry.pid),
        ])
        const related = descendantClosure(processes, seeds)
        const captured = processes.filter((entry) => related.has(entry.pid))
        yield* Ref.set(tracked, {
          pids: new Set([...state.pids, ...captured.map((entry) => entry.pid)]),
          processGroupIds: state.processGroupIds,
        })
        return captured
      })
      const track = Effect.fn("ResourceSampler.track")(function* (pids: ReadonlyArray<number>) {
        const valid = pids.filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
        const processes = yield* processTable
        const ownedProcessGroups = processes
          .filter((entry) => valid.includes(entry.pid) && entry.processGroupId === entry.pid)
          .map((entry) => entry.processGroupId)
        yield* Ref.update(tracked, (state) => ({
          pids: new Set([...state.pids, ...valid]),
          processGroupIds: new Set([...state.processGroupIds, ...ownedProcessGroups]),
        }))
        yield* capture()
      })
      const descendants = Effect.fn("ResourceSampler.descendants")(function* (pids: ReadonlyArray<number>) {
        const roots = new Set(pids)
        const processes = yield* processTable
        const related = descendantClosure(processes, roots)
        return processes.filter((entry) => related.has(entry.pid) && !roots.has(entry.pid))
      })
      const scanOrphans = capture().pipe(
        Effect.map((processes) =>
          processes
            .filter((entry) => entry.pid !== process.pid && !entry.status.startsWith("Z"))
            .toSorted((a, b) => a.pid - b.pid),
        ),
      )
      const signal = Effect.fn("ResourceSampler.signal")(function* (
        processes: ReadonlyArray<OrphanProcess>,
        name: NodeJS.Signals,
      ) {
        yield* Effect.forEach(
          processes,
          (entry) =>
            Effect.sync(() => {
              try {
                process.kill(entry.pid, name)
              } catch (cause) {
                if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause
              }
            }).pipe(Effect.mapError((cause) => failure(`kill -${name} ${entry.pid}`, cause))),
          {
            concurrency: 16,
            discard: true,
          },
        )
      })
      const awaitExit = Effect.fn("ResourceSampler.awaitExit")(function* (timeout: number) {
        const started = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
        while (true) {
          const current = yield* scanOrphans
          if (current.length === 0) return current
          const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
          if (now - started >= timeout) return current
          yield* Effect.sleep("50 millis")
        }
      })
      const terminateOrphans = Effect.gen(function* () {
        const detected = yield* scanOrphans
        yield* signal(detected, "SIGTERM")
        const afterTerm = yield* awaitExit(2_000)
        yield* signal(afterTerm, "SIGKILL")
        const remaining = yield* awaitExit(5_000)
        return { detected, remaining } satisfies ProcessCleanup
      })
      yield* Effect.forkScoped(Effect.forever(Effect.sleep(25).pipe(Effect.andThen(capture()))))
      const watch = Effect.fn("ResourceSampler.watch")(function* (pid: number) {
        const first = yield* snapshot(pid)
        if (first === undefined)
          return yield* ResourceSamplingError.make({
            operation: `watch process ${pid}`,
            message: "process exited before its first sample",
          })
        const series = yield* Ref.make<ReadonlyArray<ResourceSample>>([first])
        const poll: Effect.Effect<void, ResourceSamplingError> = Effect.suspend(() =>
          Effect.sleep(interval).pipe(
            Effect.andThen(snapshot(pid)),
            Effect.flatMap((sample) =>
              sample === undefined
                ? Effect.void
                : Ref.update(series, (samples) => [...samples, sample]).pipe(Effect.andThen(poll)),
            ),
          ),
        )
        const fiber = yield* FiberSet.run(fibers, poll)
        return {
          pid,
          series: Ref.get(series),
          summary: Ref.get(series).pipe(Effect.map(summarize)),
          stop: Fiber.interrupt(fiber).pipe(Effect.asVoid),
        } satisfies ProcessResources
      })
      return Service.of({ snapshot, watch, track, descendants, scanOrphans, terminateOrphans })
    }),
  )
