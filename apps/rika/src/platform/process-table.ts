import { Clock, Data, Effect, FileSystem, Function, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { clientRuntime, matchesClientProcess, type ProcessMeasurement, type ProcessObservation } from "./performance"

export interface PsRow {
  readonly pid: number
  readonly parent: number
  readonly rss: number
  readonly cpu: number
  readonly cpuSeconds: number
  readonly command: string
}

export class ProcessObservationError extends Data.TaggedError("ProcessObservationError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const parsePsRows = (output: string): ReadonlyArray<PsRow> =>
  output
    .trim()
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.+)$/.exec(line)
      const parts = match?.[5]?.split(":").map(Number)
      const cpuSeconds =
        parts === undefined
          ? 0
          : parts.reduce((total, part, index) => total + part * 60 ** (parts.length - index - 1), 0)
      return match === null
        ? []
        : [
            {
              pid: Number(match[1]),
              parent: Number(match[2]),
              rss: Number(match[3]),
              cpu: Number(match[4]),
              cpuSeconds,
              command: match[6]!,
            },
          ]
    })

export const readProcessRows = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const child = yield* spawner.spawn(
    ChildProcess.make("ps", ["-axo", "pid=,ppid=,rss=,%cpu=,time=,command="], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }),
  )
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      Stream.mkString(Stream.decodeText(child.stdout)),
      Stream.mkString(Stream.decodeText(child.stderr)),
      child.exitCode,
    ],
    { concurrency: 3 },
  )
  if (Number(exitCode) !== 0) return yield* Effect.fail(stderr)
  return parsePsRows(stdout)
}).pipe(
  Effect.mapError((cause) => new ProcessObservationError({ message: "Unable to sample the process table", cause })),
)

const descendantsImpl = (rows: ReadonlyArray<PsRow>, root: number) => {
  const ids = new Set([root])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows)
      if (ids.has(row.parent) && !ids.has(row.pid)) {
        ids.add(row.pid)
        changed = true
      }
  }
  return rows.filter((row) => ids.has(row.pid))
}

export const descendants: {
  (rows: ReadonlyArray<PsRow>, root: number): ReadonlyArray<PsRow>
  (root: number): (rows: ReadonlyArray<PsRow>) => ReadonlyArray<PsRow>
} = Function.dual(2, descendantsImpl)

const observedClientRowImpl = (rows: ReadonlyArray<PsRow>, root: number, runtime: ReturnType<typeof clientRuntime>) =>
  descendants(rows, root).find((row) => matchesClientProcess({ command: row.command, runtime }))

export const observedClientRow: {
  (rows: ReadonlyArray<PsRow>, root: number, runtime: ReturnType<typeof clientRuntime>): PsRow | undefined
  (root: number, runtime: ReturnType<typeof clientRuntime>): (rows: ReadonlyArray<PsRow>) => PsRow | undefined
} = Function.dual(3, observedClientRowImpl)

const processSubtreeRssImpl = (rows: ReadonlyArray<PsRow>, root: number): number =>
  descendants(rows, root).reduce((total, row) => total + row.rss, 0)

export const processSubtreeRss: {
  (rows: ReadonlyArray<PsRow>, root: number): number
  (root: number): (rows: ReadonlyArray<PsRow>) => number
} = Function.dual(2, processSubtreeRssImpl)

type CpuSample = {
  readonly value: number
  readonly stable: boolean
}

const cpuSample = (
  previousRows: ReadonlyArray<PsRow>,
  currentRows: ReadonlyArray<PsRow>,
  root: number,
  baselinePids: ReadonlySet<number>,
  elapsedSeconds: number,
  processMatchesClient: (row: PsRow) => boolean,
): CpuSample => {
  const selected = (rows: ReadonlyArray<PsRow>) =>
    descendants(rows, root)
      .filter((row) => !baselinePids.has(row.pid))
      .find(processMatchesClient)
  const before = selected(previousRows)
  const after = selected(currentRows)
  const stable = before !== undefined && after !== undefined && before.pid === after.pid
  const value = stable ? Math.max(0, ((after.cpuSeconds - before.cpuSeconds) / elapsedSeconds) * 100) : 0
  return { value, stable }
}

const mean = (values: ReadonlyArray<number>) => values.reduce((total, value) => total + value, 0) / values.length

export const observeProcesses = Effect.fn("PerformancePlatform.observeProcesses")(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const temporaryHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-performance-" })
  const moduleDirectory = import.meta.dir ?? path.dirname(decodeURIComponent(new URL(import.meta.url).pathname))
  const sourceDirectory = path.dirname(moduleDirectory)
  const packaged = import.meta.path?.startsWith("/$bunfs/") ?? false
  const directory = packaged ? path.dirname(process.execPath) : sourceDirectory
  const runtime = clientRuntime({ packaged, executable: process.execPath, sourceDirectory: directory })
  const executableBytes = yield* fileSystem.stat(runtime.evidencePath).pipe(Effect.map((info) => Number(info.size)))
  if (process.platform !== "darwin") {
    const unsupported: ProcessObservation = {
      executableBytes,
      unsupportedReason: "Process-tree RSS and CPU sampling currently requires Darwin ps and script PTY semantics.",
    }
    return unsupported
  }
  const processMatchesClient = (row: PsRow) => matchesClientProcess({ command: row.command, runtime })
  const baselinePids = new Set((yield* readProcessRows).map((row) => row.pid))
  return yield* Effect.acquireUseRelease(
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      const ownedPids = new Set<number>()
      const child = yield* spawner.spawn(
        ChildProcess.make(
          "/bin/sh",
          [
            "-c",
            `tail -f /dev/null | exec script -q /dev/null /bin/sh -c 'stty rows 36 cols 120; exec "$@"' rika-pty "$@"`,
            "rika-performance",
            runtime.executable,
            ...runtime.arguments,
          ],
          {
            cwd: temporaryHome,
            extendEnv: true,
            env: {
              HOME: temporaryHome,
              TERM: "xterm-256color",
            },
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            detached: true,
          },
        ),
      )
      return { child, ownedPids, startedAt }
    }),
    ({ child, ownedPids, startedAt }) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt <= 40; attempt += 1) {
          const readyRows = descendants(yield* readProcessRows, child.pid).filter((row) => !baselinePids.has(row.pid))
          for (const row of readyRows) if (processMatchesClient(row)) ownedPids.add(row.pid)
          const ready = readyRows.some((row) => processMatchesClient(row) && row.rss > 1024)
          if (ready || attempt === 40) break
          yield* Effect.sleep("250 millis")
        }
        const startupToProcessPresenceMilliseconds = (yield* Clock.currentTimeMillis) - startedAt
        yield* Effect.sleep("8 seconds")
        let previousRows = yield* readProcessRows
        const clientCpu: Array<number> = []
        const totalCpu: Array<number> = []
        let stableProcess = true
        let currentRows = previousRows
        for (let sample = 0; sample < 5; sample += 1) {
          const sampleStartedAt = yield* Clock.currentTimeMillis
          yield* Effect.sleep("1 second")
          currentRows = yield* readProcessRows
          const elapsedSeconds = ((yield* Clock.currentTimeMillis) - sampleStartedAt) / 1000
          const sampled = cpuSample(
            previousRows,
            currentRows,
            child.pid,
            baselinePids,
            elapsedSeconds,
            processMatchesClient,
          )
          const after = observedClientRow(currentRows, child.pid, runtime)
          if (after !== undefined) ownedPids.add(after.pid)
          stableProcess = stableProcess && sampled.stable
          clientCpu.push(sampled.value)
          totalCpu.push(sampled.value)
          previousRows = currentRows
        }
        const tree = descendants(currentRows, child.pid).filter((row) => !baselinePids.has(row.pid))
        const clientRow = tree.find(processMatchesClient)
        if (clientRow !== undefined) ownedPids.add(clientRow.pid)
        const client = (row: PsRow): ProcessMeasurement => ({
          pid: row.pid,
          executable: path.basename(runtime.evidencePath),
          runtimeKind: runtime.kind,
          rssMebibytes: processSubtreeRss(tree, row.pid) / 1024,
          cpuPercent: mean(clientCpu),
        })
        const base = { descendantCount: tree.length - 1, executableBytes }
        if (clientRow === undefined)
          return {
            ...base,
            unsupportedReason: "The isolated PTY did not expose the client process before sampling.",
          } satisfies ProcessObservation
        const measured: ProcessObservation = {
          ...base,
          client: client(clientRow),
          sampleCount: totalCpu.length,
          terminalColumns: 120,
          terminalRows: 36,
          startupToProcessPresenceMilliseconds,
        }
        if (!stableProcess) return measured
        return {
          ...measured,
          idleCpuMeanPercent: mean(totalCpu),
          idleCpuPeakPercent: Math.max(...totalCpu),
        }
      }),
    ({ child, ownedPids }) =>
      Effect.gen(function* () {
        const finalRows = yield* readProcessRows.pipe(Effect.orElseSucceed((): ReadonlyArray<PsRow> => []))
        for (const row of descendants(finalRows, child.pid)) ownedPids.add(row.pid)
        yield* child.kill({ killSignal: "SIGTERM" }).pipe(Effect.ignore)
        for (
          let attempt = 0;
          attempt < 20 && (yield* child.isRunning.pipe(Effect.orElseSucceed(() => false)));
          attempt += 1
        )
          yield* Effect.sleep("50 millis")
        if (yield* child.isRunning.pipe(Effect.orElseSucceed(() => false)))
          yield* child.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore)
      }),
  )
})
