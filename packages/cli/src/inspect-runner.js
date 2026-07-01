import { existsSync } from "node:fs"
import { dirname, join } from "node:path"

export async function launchInspect(args, env) {
  const command = inspectCommand(env)
  const launched = Bun.spawn([...command, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: childEnv(env),
    cwd: dirname(command[1]),
  })
  const exitCode = await launched.exited
  if (exitCode !== 0) throw new Error(`Rika Inspect exited ${exitCode}`)
}

export function inspectCommand(env = process.env) {
  const bun = env.RIKA_BUN_EXECUTABLE ?? "bun"
  const script = env.RIKA_INSPECT_SCRIPT ?? resolveInspectScript()
  return [bun, script]
}

function childEnv(env) {
  const values = { ...process.env }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete values[key]
    else values[key] = value
  }
  return values
}

function resolveInspectScript() {
  const installed = join(dirname(process.execPath), "..", "share", "rika", "inspect", "inspect.js")
  if (existsSync(installed)) return installed
  const localScript = resolveLocalInspectScript()
  if (localScript !== undefined) return localScript
  try {
    return Bun.resolveSync("@rika/motel/src/motel.ts", process.cwd())
  } catch {}
  throw new Error("Cannot find bundled Rika Inspect. Run bun install or reinstall Rika.")
}

function resolveLocalInspectScript() {
  for (const root of candidateRoots()) {
    const script = join(root, "packages", "motel", "src", "motel.ts")
    if (existsSync(script)) return script
  }
  return undefined
}

function candidateRoots() {
  const roots = []
  let current = process.cwd()
  while (true) {
    roots.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return roots
}
