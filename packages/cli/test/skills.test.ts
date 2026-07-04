import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { SkillRegistry } from "@rika/agent"
import { Config, Time } from "@rika/core"
import { Common } from "@rika/schema"
import { Effect, Layer, Schema } from "effect"
import { Output, SkillInstaller, Skills } from "../src/index"

const now = Common.TimestampMillis.make(1_980_000_003_000)

const deploySkill: SkillRegistry.Skill = {
  summary: {
    name: "deploy",
    description: "Deploy safely",
    source: "project",
    directory: "/workspace/.agents/skills/deploy",
    skill_file: "/workspace/.agents/skills/deploy/SKILL.md",
  },
  instructions: "Deploy instructions",
  resources: [{ path: "/workspace/.agents/skills/deploy/scripts/deploy.ts", relative_path: "scripts/deploy.ts" }],
}

const makeLayer = (output: Output.MemoryOutput) =>
  Skills.layer.pipe(
    Layer.provideMerge(Output.memoryLayer(output)),
    Layer.provideMerge(SkillRegistry.fakeLayer([deploySkill])),
    Layer.provideMerge(SkillInstaller.fakeLayer),
  )

describe("CLI skill commands", () => {
  test("prints installed skill summaries as JSON", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Skills.executeCommand({ type: "skills", action: "list" }).pipe(Effect.provide(makeLayer(output))),
    )

    expect(exitCode).toBe(0)
    expect(output.stderr).toEqual([])
    const summaries = Schema.decodeUnknownSync(Schema.Array(SkillRegistry.SkillSummary))(
      JSON.parse(output.stdout[0] ?? "[]"),
    )
    expect(summaries).toEqual([deploySkill.summary])
  })

  test("prints full selected skill metadata as JSON", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Skills.executeCommand({ type: "skills", action: "inspect", name: "deploy" }).pipe(
        Effect.provide(makeLayer(output)),
      ),
    )

    expect(exitCode).toBe(0)
    const skill = Schema.decodeUnknownSync(SkillRegistry.Skill)(JSON.parse(output.stdout[0] ?? "{}"))
    expect(skill).toEqual(deploySkill)
  })

  test("adds a root skill from a local git source and records provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-cli-skills-"))
    const workspace = join(root, "workspace")
    const home = join(root, "home")
    const repo = join(root, "repo")
    await writeSkill(repo, "deploy", "Deploy safely", "Deploy instructions")
    const commit = await commitRepo(repo)
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const source = pathToFileURL(repo).href

    const exitCode = await Effect.runPromise(
      Skills.executeCommand({
        type: "skills",
        action: "add",
        source,
        user: false,
        force: false,
      }).pipe(Effect.provide(makeInstallLayer(output, workspace, home))),
    )

    const result = JSON.parse(output.stdout[0] ?? "{}")
    const installed = await readFile(join(workspace, ".agents", "skills", "deploy", "SKILL.md"), "utf8")
    const lock = JSON.parse(await readFile(join(workspace, ".agents", "skills", "skills-lock.json"), "utf8"))

    expect(exitCode).toBe(0)
    expect(result).toMatchObject({
      action: "add",
      name: "deploy",
      scope: "project",
      source,
      commit,
    })
    expect(installed).toContain("Deploy instructions")
    expect(lock.skills.deploy).toMatchObject({ source, commit, scope: "project" })
    expect(output.stderr).toEqual([])
    await rm(root, { recursive: true, force: true })
  })

  test("adds a nested skill path from a git source", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-cli-skills-"))
    const workspace = join(root, "workspace")
    const home = join(root, "home")
    const repo = join(root, "repo")
    await writeSkill(join(repo, "skills", "review"), "review", "Review safely", "Review instructions")
    await commitRepo(repo)
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const source = `${pathToFileURL(repo).href}#skills/review`

    const exitCode = await Effect.runPromise(
      Skills.executeCommand({
        type: "skills",
        action: "add",
        source,
        user: false,
        force: false,
      }).pipe(Effect.provide(makeInstallLayer(output, workspace, home))),
    )

    const installed = await readFile(join(workspace, ".agents", "skills", "review", "SKILL.md"), "utf8")

    expect(exitCode).toBe(0)
    expect(JSON.parse(output.stdout[0] ?? "{}")).toMatchObject({ action: "add", name: "review", source })
    expect(installed).toContain("Review instructions")
    await rm(root, { recursive: true, force: true })
  })

  test("rejects unsafe skill names before installing", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-cli-skills-"))
    const workspace = join(root, "workspace")
    const home = join(root, "home")
    const repo = join(root, "repo")
    await writeSkill(repo, "..", "Unsafe skill", "Unsafe instructions")
    await commitRepo(repo)
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const source = pathToFileURL(repo).href

    const failed = await Effect.runPromise(
      Effect.result(
        Skills.executeCommand({
          type: "skills",
          action: "add",
          source,
          user: false,
          force: true,
        }).pipe(Effect.provide(makeInstallLayer(output, workspace, home))),
      ),
    )

    expect(failed._tag).toBe("Failure")
    if (failed._tag === "Failure") {
      const failure = failed.failure
      expect(failure).toBeInstanceOf(SkillInstaller.SkillInstallerError)
      if (!(failure instanceof SkillInstaller.SkillInstallerError)) throw new Error("expected SkillInstallerError")
      expect(failure.operation).toBe("validateSkill")
    }
    expect(await exists(join(workspace, ".agents"))).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  test("rejects reserved lockfile skill names before installing", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-cli-skills-"))
    const workspace = join(root, "workspace")
    const home = join(root, "home")
    const repo = join(root, "repo")
    await writeSkill(repo, "skills-lock.json", "Reserved skill", "Reserved instructions")
    await commitRepo(repo)
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const source = pathToFileURL(repo).href

    const failed = await Effect.runPromise(
      Effect.result(
        Skills.executeCommand({
          type: "skills",
          action: "add",
          source,
          user: false,
          force: true,
        }).pipe(Effect.provide(makeInstallLayer(output, workspace, home))),
      ),
    )

    expect(failed._tag).toBe("Failure")
    if (failed._tag === "Failure") {
      const failure = failed.failure
      expect(failure).toBeInstanceOf(SkillInstaller.SkillInstallerError)
      if (!(failure instanceof SkillInstaller.SkillInstallerError)) throw new Error("expected SkillInstallerError")
      expect(failure.operation).toBe("validateSkill")
    }
    expect(await exists(join(workspace, ".agents"))).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  test("rejects unsafe skill names before removing", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-cli-skills-"))
    const workspace = join(root, "workspace")
    const home = join(root, "home")
    const marker = join(workspace, ".agents", "marker")
    await mkdir(join(workspace, ".agents", "skills"), { recursive: true })
    await writeFile(marker, "keep", "utf8")
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    const failed = await Effect.runPromise(
      Effect.result(
        Skills.executeCommand({
          type: "skills",
          action: "remove",
          name: "..",
          user: false,
        }).pipe(Effect.provide(makeInstallLayer(output, workspace, home))),
      ),
    )

    expect(failed._tag).toBe("Failure")
    if (failed._tag === "Failure") {
      const failure = failed.failure
      expect(failure).toBeInstanceOf(SkillInstaller.SkillInstallerError)
      if (!(failure instanceof SkillInstaller.SkillInstallerError)) throw new Error("expected SkillInstallerError")
      expect(failure.operation).toBe("validateSkill")
    }
    expect(await readFile(marker, "utf8")).toBe("keep")
    await rm(root, { recursive: true, force: true })
  })

  test("rejects reserved lockfile names before removing", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-cli-skills-"))
    const workspace = join(root, "workspace")
    const home = join(root, "home")
    const lockPath = join(workspace, ".agents", "skills", "skills-lock.json")
    const lockText =
      '{ "skills": { "deploy": { "source": "fixture", "commit": "abc", "installed_at": 1, "scope": "project", "directory": "/workspace/.agents/skills/deploy" } } }\n'
    await mkdir(join(workspace, ".agents", "skills"), { recursive: true })
    await writeFile(lockPath, lockText, "utf8")
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    const failed = await Effect.runPromise(
      Effect.result(
        Skills.executeCommand({
          type: "skills",
          action: "remove",
          name: "skills-lock.json",
          user: false,
        }).pipe(Effect.provide(makeInstallLayer(output, workspace, home))),
      ),
    )

    expect(failed._tag).toBe("Failure")
    if (failed._tag === "Failure") {
      const failure = failed.failure
      expect(failure).toBeInstanceOf(SkillInstaller.SkillInstallerError)
      if (!(failure instanceof SkillInstaller.SkillInstallerError)) throw new Error("expected SkillInstallerError")
      expect(failure.operation).toBe("validateSkill")
    }
    expect(await readFile(lockPath, "utf8")).toBe(lockText)
    await rm(root, { recursive: true, force: true })
  })

  test("rejects non-directory skill paths before removing", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-cli-skills-"))
    const workspace = join(root, "workspace")
    const home = join(root, "home")
    const target = join(workspace, ".agents", "skills", "deploy")
    await mkdir(join(workspace, ".agents", "skills"), { recursive: true })
    await writeFile(target, "keep", "utf8")
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    const failed = await Effect.runPromise(
      Effect.result(
        Skills.executeCommand({
          type: "skills",
          action: "remove",
          name: "deploy",
          user: false,
        }).pipe(Effect.provide(makeInstallLayer(output, workspace, home))),
      ),
    )

    expect(failed._tag).toBe("Failure")
    if (failed._tag === "Failure") {
      const failure = failed.failure
      expect(failure).toBeInstanceOf(SkillInstaller.SkillInstallerError)
      if (!(failure instanceof SkillInstaller.SkillInstallerError)) throw new Error("expected SkillInstallerError")
      expect(failure.operation).toBe("remove")
    }
    expect(await readFile(target, "utf8")).toBe("keep")
    await rm(root, { recursive: true, force: true })
  })

  test("rejects skill collisions unless force is set", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-cli-skills-"))
    const workspace = join(root, "workspace")
    const home = join(root, "home")
    const repo = join(root, "repo")
    const target = join(workspace, ".agents", "skills", "deploy")
    await writeSkill(repo, "deploy", "Deploy safely", "New instructions")
    await commitRepo(repo)
    await writeSkill(target, "deploy", "Deploy safely", "Old instructions")
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const source = pathToFileURL(repo).href

    const failed = await Effect.runPromise(
      Effect.result(
        Skills.executeCommand({
          type: "skills",
          action: "add",
          source,
          user: false,
          force: false,
        }).pipe(Effect.provide(makeInstallLayer(output, workspace, home))),
      ),
    )
    const forced = await Effect.runPromise(
      Skills.executeCommand({
        type: "skills",
        action: "add",
        source,
        user: false,
        force: true,
      }).pipe(Effect.provide(makeInstallLayer(output, workspace, home))),
    )

    const installed = await readFile(join(target, "SKILL.md"), "utf8")

    expect(failed._tag).toBe("Failure")
    if (failed._tag === "Failure") expect(failed.failure).toBeInstanceOf(SkillInstaller.SkillInstallerError)
    expect(forced).toBe(0)
    expect(installed).toContain("New instructions")
    await rm(root, { recursive: true, force: true })
  })

  test("removes an installed skill directory and lock entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-cli-skills-"))
    const workspace = join(root, "workspace")
    const home = join(root, "home")
    const repo = join(root, "repo")
    await writeSkill(repo, "deploy", "Deploy safely", "Deploy instructions")
    await commitRepo(repo)
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const source = pathToFileURL(repo).href

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const add = yield* Skills.executeCommand({
          type: "skills",
          action: "add",
          source,
          user: false,
          force: false,
        })
        const remove = yield* Skills.executeCommand({
          type: "skills",
          action: "remove",
          name: "deploy",
          user: false,
        })
        return { add, remove }
      }).pipe(Effect.provide(makeInstallLayer(output, workspace, home))),
    )

    const lock = JSON.parse(await readFile(join(workspace, ".agents", "skills", "skills-lock.json"), "utf8"))

    expect(result).toEqual({ add: 0, remove: 0 })
    expect(await exists(join(workspace, ".agents", "skills", "deploy"))).toBe(false)
    expect(lock.skills.deploy).toBeUndefined()
    expect(JSON.parse(output.stdout[1] ?? "{}")).toMatchObject({ action: "remove", name: "deploy", scope: "project" })
    await rm(root, { recursive: true, force: true })
  })
})

const makeInstallLayer = (output: Output.MemoryOutput, workspaceRoot: string, home: string) => {
  const configLayer = Config.layerFromValues({
    workspace_root: workspaceRoot,
    data_dir: join(workspaceRoot, ".rika"),
    default_mode: "smart",
  })
  const timeLayer = Time.fixedLayer(now)
  const installerLayer = SkillInstaller.layer.pipe(
    Layer.provideMerge(SkillInstaller.systemLayer({ home })),
    Layer.provideMerge(configLayer),
    Layer.provideMerge(timeLayer),
  )
  return Skills.layer.pipe(
    Layer.provideMerge(Output.memoryLayer(output)),
    Layer.provideMerge(SkillRegistry.emptyLayer),
    Layer.provideMerge(installerLayer),
  )
}

const writeSkill = async (directory: string, name: string, description: string, body: string) => {
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`,
  )
}

const commitRepo = async (repo: string) => {
  await runGit(repo, ["init"])
  await runGit(repo, ["add", "."])
  await runGit(repo, ["-c", "user.email=rika@example.com", "-c", "user.name=Rika", "commit", "-m", "initial"])
  return (await runGit(repo, ["rev-parse", "HEAD"])).trim()
}

const runGit = async (cwd: string, args: ReadonlyArray<string>) => {
  const subprocess = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
  return stdout
}

const exists = async (path: string) => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
