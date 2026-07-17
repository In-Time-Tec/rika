import { Console, Effect, FileSystem, Option, Path, Schema } from "effect"
import type { Sandbox } from "./process"
import * as ResourceSampler from "./resource-sampler"

export interface DiagnosticEvent {
  readonly role: "client" | "resident"
  readonly pid: number
  readonly message: string | undefined
  readonly annotations: Readonly<Record<string, unknown>>
}

export interface HostConnections {
  readonly hostPid: number
  readonly accepted: ReadonlyArray<string>
  readonly active: ReadonlyArray<string>
}

const decodeLine = (line: string): unknown | undefined => {
  const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(line)
  return Option.isSome(decoded) ? decoded.value : undefined
}

const eventMessage = (value: unknown) =>
  typeof value === "object" && value !== null && "message" in value && typeof value.message === "string"
    ? value.message
    : undefined

const eventAnnotations = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && "annotations" in value && typeof value.annotations === "object"
    ? (value.annotations as Readonly<Record<string, unknown>>)
    : {}

const logIdentity = (name: string) => {
  const matched = name.match(/^(client|resident)-.+-(\d+)(?:\.open)?\.jsonl$/)
  if (matched === null) return undefined
  return { role: matched[1] as "client" | "resident", pid: Number(matched[2]) }
}

const diagnosticProcessPids = Effect.fn("StressSupport.diagnosticProcessPids")(function* (dataRoot: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const diagnostics = path.join(dataRoot, "diagnostics")
  if (!(yield* fileSystem.exists(diagnostics))) return []
  return [
    ...new Set(
      (yield* fileSystem.readDirectory(diagnostics))
        .map(logIdentity)
        .filter((identity): identity is NonNullable<typeof identity> => identity !== undefined)
        .map((identity) => identity.pid),
    ),
  ]
})

export const configureHomeState = Effect.fn("StressSupport.configureHomeState")(function* (context: Sandbox) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const sampler = yield* ResourceSampler.Service
  const home = context.env.HOME
  if (home === undefined) return yield* Effect.die("Sandbox HOME is missing")
  const dataRoot = path.join(home, ".rika")
  yield* fileSystem.makeDirectory(dataRoot, { recursive: true })
  context.env.RIKA_DATABASE = path.join(dataRoot, "rika.db")
  context.env.RIKA_RELAY_DATABASE = path.join(dataRoot, "relay.db")
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.sleep(25).pipe(
        Effect.andThen(diagnosticProcessPids(dataRoot)),
        Effect.flatMap((pids) => sampler.track(pids)),
        Effect.ignore,
      ),
    ),
  )
  yield* Effect.addFinalizer(() => sampler.terminateOrphans.pipe(Effect.ignore))
  return dataRoot
})

export const readDiagnosticEvents = Effect.fn("StressSupport.readDiagnosticEvents")(function* (dataRoot: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const diagnostics = path.join(dataRoot, "diagnostics")
  if (!(yield* fileSystem.exists(diagnostics))) return []
  const events = new Array<DiagnosticEvent>()
  for (const name of yield* fileSystem.readDirectory(diagnostics)) {
    const identity = logIdentity(name)
    if (identity === undefined) continue
    const text = yield* fileSystem.readFileString(path.join(diagnostics, name)).pipe(Effect.orElseSucceed(() => ""))
    for (const line of text.split("\n")) {
      const value = decodeLine(line)
      if (value === undefined) continue
      events.push({ ...identity, message: eventMessage(value), annotations: eventAnnotations(value) })
    }
  }
  return events
})

const connectionId = (event: DiagnosticEvent) => {
  const value = event.annotations["rika.resident.connection.id"]
  return typeof value === "string" ? value : undefined
}

export const hostConnections = (events: ReadonlyArray<DiagnosticEvent>): ReadonlyArray<HostConnections> => {
  const residentPids = [...new Set(events.filter((event) => event.role === "resident").map((event) => event.pid))]
  return residentPids.map((hostPid) => {
    const hostEvents = events.filter((event) => event.pid === hostPid)
    const accepted = hostEvents
      .filter((event) => event.message === "resident.connection.accepted")
      .map(connectionId)
      .filter((value): value is string => value !== undefined)
    const closed = new Set(
      hostEvents
        .filter((event) => event.message === "resident.connection.closed")
        .map(connectionId)
        .filter((value): value is string => value !== undefined),
    )
    return {
      hostPid,
      accepted: [...new Set(accepted)],
      active: [...new Set(accepted)].filter((id) => !closed.has(id)),
    }
  })
}

export const waitUntil = Effect.fn("StressSupport.waitUntil")(function* <A, E, R>(
  operation: string,
  check: Effect.Effect<A | undefined, E, R>,
  timeoutMilliseconds = 15_000,
) {
  const started = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
  while (true) {
    const value = yield* check
    if (value !== undefined) return value
    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
    if (now - started >= timeoutMilliseconds) return yield* Effect.die(`${operation} exceeded ${timeoutMilliseconds}ms`)
    yield* Effect.sleep("25 millis")
  }
})

export const waitForHostConnections = Effect.fn("StressSupport.waitForHostConnections")(function* (
  dataRoot: string,
  minimum: number,
  excludedHostPids: ReadonlySet<number> = new Set(),
) {
  const host = yield* waitUntil(
    `wait for ${minimum} resident connections`,
    readDiagnosticEvents(dataRoot).pipe(
      Effect.map((events) =>
        hostConnections(events)
          .filter((connection) => !excludedHostPids.has(connection.hostPid))
          .find((connection) => connection.active.length >= minimum),
      ),
    ),
    30_000,
  )
  const sampler = yield* ResourceSampler.Service
  yield* sampler.track([host.hostPid])
  return host
})

export const waitForProcessExit = Effect.fn("StressSupport.waitForProcessExit")(function* (
  pid: number,
  timeoutMilliseconds = 15_000,
) {
  return yield* waitUntil(
    `wait for process ${pid} to exit`,
    Effect.sync(() => {
      try {
        process.kill(pid, 0)
        return undefined
      } catch {
        return true
      }
    }),
    timeoutMilliseconds,
  )
})

export const processChildren = Effect.fn("StressSupport.processChildren")(function* (pid: number) {
  const sampler = yield* ResourceSampler.Service
  const children = yield* sampler.descendants([pid])
  return children.map((child) => child.pid)
})

export const cleanupScenario = Effect.fn("StressSupport.cleanupScenario")(function* () {
  const sampler = yield* ResourceSampler.Service
  return (yield* sampler.terminateOrphans).remaining
})

export const rssTrend = (series: ReadonlyArray<ResourceSampler.ResourceSample>) => {
  if (series.length < 2) return { growthKilobytes: 0, slopeKilobytesPerSecond: 0 }
  const origin = series[0]!.timestampMilliseconds
  const times = series.map((sample) => (sample.timestampMilliseconds - origin) / 1_000)
  const values = series.map((sample) => sample.rssKilobytes)
  const meanTime = times.reduce((total, value) => total + value, 0) / times.length
  const meanRss = values.reduce((total, value) => total + value, 0) / values.length
  const numerator = times.reduce((total, value, index) => total + (value - meanTime) * (values[index]! - meanRss), 0)
  const denominator = times.reduce((total, value) => total + (value - meanTime) ** 2, 0)
  return {
    growthKilobytes: values.at(-1)! - values[0]!,
    slopeKilobytesPerSecond: denominator === 0 ? 0 : numerator / denominator,
  }
}

export const printMetrics = Effect.fn("StressSupport.printMetrics")(function* (
  scenario: string,
  metrics: Readonly<Record<string, unknown>>,
) {
  const encoded = yield* Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)({ scenario, ...metrics })
  yield* Console.log(`RIKA_STRESS_METRICS ${encoded}`)
})
