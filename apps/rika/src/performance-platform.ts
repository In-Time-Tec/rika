import { Data, Effect, FileSystem, Path } from "effect"

export type PerformanceRole = "launcher" | "interactive" | "server"

export interface RoleObservation {
  readonly role: PerformanceRole
  readonly pid: number
  readonly executable: string
  readonly rssMebibytes: number
  readonly cpuPercent: number
}

export interface ProcessObservation {
  readonly roles: ReadonlyArray<RoleObservation>
  readonly sampleCount?: number
  readonly terminalColumns?: number
  readonly terminalRows?: number
  readonly startupToRolePresenceMilliseconds?: number
  readonly idleCpuMeanPercent?: number
  readonly idleCpuPeakPercent?: number
  readonly executableBytes: Readonly<Record<PerformanceRole, number>>
  readonly unsupportedReason?: string
}

export interface RoleRuntime {
  readonly executable: string
  readonly arguments: ReadonlyArray<string>
  readonly evidencePath: string
}

export const roleRuntimes = (input: {
  readonly packaged: boolean
  readonly executable: string
  readonly sourceDirectory: string
}): Readonly<Record<PerformanceRole, RoleRuntime>> => {
  const sibling = (name: string) => `${input.sourceDirectory}/${name}`
  const source = (name: string) => `${input.sourceDirectory}/${name}-main.ts`
  return {
    launcher: {
      executable: input.packaged ? sibling("rika") : input.executable,
      arguments: input.packaged ? [] : [source("client")],
      evidencePath: input.packaged ? sibling("rika") : source("client"),
    },
    interactive: input.packaged
      ? { executable: sibling(".rika-interactive"), arguments: [], evidencePath: sibling(".rika-interactive") }
      : { executable: input.executable, arguments: [source("interactive")], evidencePath: source("interactive") },
    server: input.packaged
      ? { executable: sibling(".rika-server"), arguments: [], evidencePath: sibling(".rika-server") }
      : { executable: input.executable, arguments: [source("server")], evidencePath: source("server") },
  }
}

interface PsRow {
  readonly pid: number
  readonly parent: number
  readonly rss: number
  readonly cpu: number
  readonly cpuSeconds: number
  readonly command: string
}

class ProcessObservationError extends Data.TaggedError("ProcessObservationError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const psRows = (): ReadonlyArray<PsRow> => {
  const result = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,rss=,%cpu=,time=,command="])
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
  return new TextDecoder()
    .decode(result.stdout)
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
}

const readProcessRows = Effect.try({
  try: psRows,
  catch: (cause) => new ProcessObservationError({ message: "Unable to sample the process table", cause }),
})

const descendants = (rows: ReadonlyArray<PsRow>, root: number) => {
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

const killTree = (pid: number) => {
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    try {
      process.kill(pid, "SIGTERM")
    } catch {}
  }
}

const signal = (pid: number, value: NodeJS.Signals) => {
  try {
    process.kill(pid, value)
  } catch {}
}

const running = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const observeProcesses = Effect.fn("PerformancePlatform.observeProcesses")(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const temporaryHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-performance-" })
  const sourceDirectory = import.meta.dir ?? path.dirname(decodeURIComponent(new URL(import.meta.url).pathname))
  const packaged = import.meta.path?.startsWith("/$bunfs/") ?? false
  const directory = packaged ? path.dirname(process.execPath) : sourceDirectory
  const runtimes = roleRuntimes({ packaged, executable: process.execPath, sourceDirectory: directory })
  const executableBytes = yield* Effect.all(
    Object.entries(runtimes).map(([role, runtime]) =>
      fileSystem.stat(runtime.evidencePath).pipe(Effect.map((info) => [role, Number(info.size)] as const)),
    ),
  ).pipe(Effect.map(Object.fromEntries))
  if (process.platform !== "darwin")
    return {
      roles: [],
      executableBytes,
      unsupportedReason: "Process-tree RSS and CPU sampling currently requires Darwin ps and script PTY semantics.",
    }
  const launcher = runtimes.launcher
  const matchesRole = (row: PsRow, role: PerformanceRole) => {
    const runtime = runtimes[role]
    if (!packaged) return row.command.includes(runtime.evidencePath)
    const executable = row.command.split(/\s+/, 1)[0] ?? ""
    return path.basename(executable) === path.basename(runtime.executable)
  }
  const baselinePids = new Set((yield* readProcessRows).map((row) => row.pid))
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => {
      const startedAt = performance.now()
      const ownedPids = new Set<number>()
      const child = Bun.spawn(
        [
          "/bin/sh",
          "-c",
          `tail -f /dev/null | exec script -q /dev/null /bin/sh -c 'stty rows 36 cols 120; exec "$@"' rika-pty "$@"`,
          "rika-performance",
          launcher.executable,
          ...launcher.arguments,
        ],
        {
          cwd: temporaryHome,
          env: {
            ...process.env,
            HOME: temporaryHome,
            RIKA_DATABASE: path.join(temporaryHome, ".rika", "rika.db"),
            RIKA_INTERNAL_SERVER_GRACE: "30000",
            RIKA_TEST_MODEL_RESPONSE: "performance fixture",
            TERM: "xterm-256color",
          },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          detached: true,
        },
      )
      return { child, ownedPids, startedAt }
    }),
    ({ child, ownedPids, startedAt }) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt <= 40; attempt += 1) {
          const readyRows = descendants(yield* readProcessRows, child.pid).filter((row) => !baselinePids.has(row.pid))
          for (const row of readyRows)
            if (matchesRole(row, "launcher") || matchesRole(row, "interactive") || matchesRole(row, "server"))
              ownedPids.add(row.pid)
          const ready =
            readyRows.some((row) => matchesRole(row, "interactive") && row.rss > 1024) &&
            readyRows.some((row) => matchesRole(row, "server") && row.rss > 1024)
          if (ready || attempt === 40) break
          yield* Effect.sleep("250 millis")
        }
        const startupToRolePresenceMilliseconds = performance.now() - startedAt
        yield* Effect.sleep("8 seconds")
        let previousRows = yield* readProcessRows
        const roleCpu = new Map<PerformanceRole, Array<number>>(
          (["launcher", "interactive", "server"] as const).map((role) => [role, []]),
        )
        const totalCpu: Array<number> = []
        let stableRoles = true
        let currentRows = previousRows
        for (let sample = 0; sample < 5; sample += 1) {
          const sampleStartedAt = performance.now()
          yield* Effect.sleep("1 second")
          currentRows = yield* readProcessRows
          const elapsedSeconds = (performance.now() - sampleStartedAt) / 1000
          const previousTree = descendants(previousRows, child.pid).filter((row) => !baselinePids.has(row.pid))
          const currentTree = descendants(currentRows, child.pid).filter((row) => !baselinePids.has(row.pid))
          let total = 0
          for (const name of ["launcher", "interactive", "server"] as const) {
            const before = previousTree.find((row) => matchesRole(row, name))
            const after = currentTree.find((row) => matchesRole(row, name))
            if (after !== undefined) ownedPids.add(after.pid)
            if (before?.pid !== after?.pid) stableRoles = false
            const value =
              before === undefined || after === undefined || before.pid !== after.pid
                ? 0
                : Math.max(0, ((after.cpuSeconds - before.cpuSeconds) / elapsedSeconds) * 100)
            roleCpu.get(name)!.push(value)
            total += value
          }
          totalCpu.push(total)
          previousRows = currentRows
        }
        const tree = descendants(currentRows, child.pid).filter((row) => !baselinePids.has(row.pid))
        const launcherRow = tree.find((row) => matchesRole(row, "launcher"))
        const interactiveRow = tree.find((row) => matchesRole(row, "interactive"))
        const serverRow = tree.find((row) => matchesRole(row, "server"))
        for (const row of [launcherRow, interactiveRow, serverRow]) if (row !== undefined) ownedPids.add(row.pid)
        const role = (name: PerformanceRole, row: PsRow, executable: string): RoleObservation => ({
          role: name,
          pid: row.pid,
          executable,
          rssMebibytes: row.rss / 1024,
          cpuPercent: roleCpu.get(name)!.reduce((total, value) => total + value, 0) / totalCpu.length,
        })
        return {
          roles: [
            ...(launcherRow === undefined ? [] : [role("launcher", launcherRow, runtimes.launcher.evidencePath)]),
            ...(interactiveRow === undefined
              ? []
              : [role("interactive", interactiveRow, runtimes.interactive.evidencePath)]),
            ...(serverRow === undefined ? [] : [role("server", serverRow, runtimes.server.evidencePath)]),
          ],
          ...(interactiveRow === undefined || serverRow === undefined
            ? {}
            : {
                sampleCount: totalCpu.length,
                terminalColumns: 120,
                terminalRows: 36,
                startupToRolePresenceMilliseconds,
                ...(stableRoles
                  ? {
                      idleCpuMeanPercent: totalCpu.reduce((total, value) => total + value, 0) / totalCpu.length,
                      idleCpuPeakPercent: Math.max(...totalCpu),
                    }
                  : {}),
              }),
          executableBytes,
          ...(interactiveRow === undefined || serverRow === undefined
            ? { unsupportedReason: "The isolated PTY did not expose every expected process role before sampling." }
            : {}),
        }
      }),
    ({ child, ownedPids }) =>
      Effect.gen(function* () {
        for (const row of descendants(yield* readProcessRows, child.pid)) ownedPids.add(row.pid)
        killTree(child.pid)
        for (const pid of ownedPids) signal(pid, "SIGTERM")
        for (let attempt = 0; attempt < 20 && [...ownedPids].some(running); attempt += 1)
          yield* Effect.sleep("50 millis")
        for (const pid of ownedPids) if (running(pid)) signal(pid, "SIGKILL")
        for (let attempt = 0; attempt < 20 && [...ownedPids].some(running); attempt += 1)
          yield* Effect.sleep("50 millis")
      }),
  )
})
