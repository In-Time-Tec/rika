import { Data, Effect, FileSystem, Path } from "effect"
import { descendants, readProcessRows, type PsRow } from "../src/platform/performance-platform"

export type IdleRole = "client" | "interactive" | "server"

export interface IdleSeries {
  readonly role: IdleRole
  readonly pid: number
  readonly cpuPercent: ReadonlyArray<number>
  readonly rssMebibytes: ReadonlyArray<number>
}

export class IdleFixtureError extends Data.TaggedError("IdleFixtureError")<{
  readonly message: string
}> {}

const roleMarkers: Readonly<Record<IdleRole, string>> = {
  client: "apps/rika/src/client-main.ts",
  interactive: "apps/rika/src/interactive-main.ts",
  server: "apps/rika/src/server-main.ts",
}

const running = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const signal = (pid: number, value: NodeJS.Signals) => {
  try {
    process.kill(pid, value)
  } catch {}
}

const roleOf = (row: PsRow, executableName: string): IdleRole | undefined => {
  const executable = row.command.split(/\s+/, 1)[0] ?? ""
  if (executable.slice(executable.lastIndexOf("/") + 1) !== executableName) return undefined
  for (const role of ["client", "interactive", "server"] as const)
    if (row.command.includes(roleMarkers[role])) return role
  return undefined
}

const observedRoles = (rows: ReadonlyArray<PsRow>, owned: ReadonlySet<number>, executableName: string) => {
  const found = new Map<IdleRole, PsRow>()
  for (const row of rows) {
    if (!owned.has(row.pid)) continue
    const role = roleOf(row, executableName)
    if (role !== undefined && !found.has(role)) found.set(role, row)
  }
  return found
}

const isolatedEnvironment = (home: string, path: Path.Path) => ({
  ...process.env,
  HOME: home,
  RIKA_DATABASE: path.join(home, ".rika", "rika.db"),
  RIKA_INTERNAL_SERVER_GRACE: "60000",
  RIKA_TEST_MODEL_RESPONSE: "idle gate fixture",
  TERM: "xterm-256color",
})

const ptyLauncher = (repositoryRoot: string, home: string, path: Path.Path) =>
  Bun.spawn(
    [
      "python3",
      path.join(repositoryRoot, "apps", "rika", "test", "fixtures", "idle-pty.py"),
      process.execPath,
      path.join(repositoryRoot, "apps", "rika", "src", "client-main.ts"),
    ],
    {
      cwd: home,
      env: isolatedEnvironment(home, path),
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    },
  )

export interface IdleObservation {
  readonly series: ReadonlyArray<IdleSeries>
  readonly ownedPids: ReadonlyArray<number>
  readonly survivingPids: ReadonlyArray<number>
}

export const observeIdleProcessTree = Effect.fn("IdleGate.observe")(function* (input: {
  readonly repositoryRoot: string
  readonly samples: number
  readonly sampleMillis: number
  readonly readyTimeoutMillis: number
  readonly settleMillis: number
  readonly turns: ReadonlyArray<string>
  readonly turnSettleMillis: number
}) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-idle-gate-" })
  const owned = new Set<number>()
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => ptyLauncher(input.repositoryRoot, home, path)),
    (launcher) =>
      Effect.gen(function* () {
        const executableName = process.execPath.slice(process.execPath.lastIndexOf("/") + 1)
        const track = Effect.gen(function* () {
          const rows = descendants(yield* readProcessRows, launcher.pid)
          for (const row of rows) owned.add(row.pid)
          return observedRoles(rows, owned, executableName)
        })
        let roles = yield* track
        const deadline = input.readyTimeoutMillis / 100
        for (let attempt = 0; attempt < deadline && roles.size < 3; attempt += 1) {
          yield* Effect.sleep("100 millis")
          roles = yield* track
        }
        if (roles.size < 3)
          return yield* new IdleFixtureError({
            message: `The isolated launcher exposed ${roles.size} of 3 roles before the readiness ceiling.`,
          })
        /**
         * A Server warms up over its first turns and then holds. Sampling only after the last turn
         * cannot tell a plateau from a climb, so each turn's resting size is recorded as it happens.
         */
        const perTurnServerRss: Array<number> = []
        for (const turn of input.turns) {
          yield* Effect.sync(() => launcher.stdin.write(`${turn}\r`))
          yield* Effect.sync(() => launcher.stdin.flush())
          yield* Effect.sleep(input.turnSettleMillis)
          const server = (yield* track).get("server")
          if (server !== undefined) perTurnServerRss.push(server.rss / 1_024)
        }
        yield* Effect.sleep(input.settleMillis)

        const series = new Map<IdleRole, { pid: number; cpu: Array<number>; rss: Array<number> }>()
        let previous = yield* track
        for (let sample = 0; sample < input.samples; sample += 1) {
          const startedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
          yield* Effect.sleep(input.sampleMillis)
          const current = yield* track
          const elapsedSeconds = ((yield* Effect.clockWith((clock) => clock.currentTimeMillis)) - startedAt) / 1_000
          for (const [role, row] of current) {
            const before = previous.get(role)
            if (before === undefined || before.pid !== row.pid) {
              series.delete(role)
              continue
            }
            const entry = series.get(role) ?? { pid: row.pid, cpu: [], rss: [] }
            entry.cpu.push(Math.max(0, ((row.cpuSeconds - before.cpuSeconds) / elapsedSeconds) * 100))
            entry.rss.push(row.rss / 1_024)
            series.set(role, entry)
          }
          previous = current
        }
        return {
          series: [...series].map(([role, entry]) => ({
            role,
            pid: entry.pid,
            cpuPercent: entry.cpu,
            rssMebibytes: entry.rss,
          })),
          perTurnServerRss,
          ownedPids: [...owned],
        }
      }),
    (launcher) =>
      Effect.gen(function* () {
        owned.add(launcher.pid)
        for (let sweep = 0; sweep < 40; sweep += 1) {
          for (const row of descendants(yield* readProcessRows, launcher.pid)) owned.add(row.pid)
          const live = [...owned].filter(running)
          if (live.length === 0) return
          for (const pid of live) signal(pid, sweep === 0 ? "SIGTERM" : "SIGKILL")
          yield* Effect.sleep("250 millis")
        }
      }),
  ).pipe(Effect.map((observation) => ({ ...observation, survivingPids: [...owned].filter(running) })))
})
