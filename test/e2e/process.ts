import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const artifactRoot = await mkdtemp(join(tmpdir(), "rika-artifact-"))
const artifacts = new URL("../../artifacts", import.meta.url).pathname
const archive = (await readdir(artifacts)).find((entry) => entry.endsWith(`${process.platform}-${process.arch}.tar.gz`))
if (archive === undefined) throw new Error(`Packaged artifact for ${process.platform}-${process.arch} is missing`)
const extracted = Bun.spawnSync(["tar", "-xzf", join(artifacts, archive), "-C", artifactRoot])
if (extracted.exitCode !== 0) throw new Error(extracted.stderr.toString())
export const binary = join(artifactRoot, archive.replace(".tar.gz", ""), "bin", "rika")
process.on("exit", () => void Bun.spawnSync(["rm", "-rf", artifactRoot]))

export interface Sandbox {
  readonly root: string
  readonly workspace: string
  readonly env: Record<string, string>
  readonly dispose: () => Promise<void>
}

export const sandbox = async (): Promise<Sandbox> => {
  const root = await mkdtemp(join(tmpdir(), "rika-e2e-"))
  const home = join(root, "home")
  const workspace = join(root, "workspace")
  const state = join(root, "state")
  await Promise.all([mkdir(home), mkdir(workspace), mkdir(state)])
  return {
    root,
    workspace,
    env: {
      ...process.env,
      HOME: home,
      RIKA_DATABASE: join(state, "rika.db"),
      RIKA_RELAY_DATABASE: join(state, "relay.db"),
      RIKA_TEST_MODEL_RESPONSE: "deterministic response",
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  }
}

export const run = async (
  context: Sandbox,
  args: ReadonlyArray<string>,
  options: { readonly input?: string; readonly timeout?: number } = {},
) => {
  const process = Bun.spawn([binary, ...args], {
    cwd: context.workspace,
    env: context.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  if (options.input !== undefined) process.stdin.write(options.input)
  process.stdin.end()
  const timeout = setTimeout(() => process.kill("SIGKILL"), options.timeout ?? 10_000)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ])
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode }
  } finally {
    clearTimeout(timeout)
    if (process.exitCode === null) process.kill("SIGKILL")
  }
}
