import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { Effect, Stream } from "effect"
import { LifecycleHooks } from "../src/index"

const tempRoot = () => mkdtemp(join(tmpdir(), "rika-hooks-"))

describe("LifecycleHooks", () => {
  test("runSetup streams stdout and stderr lines without asserting cross-stream order", async () => {
    const root = await tempRoot()
    try {
      await writeHook(
        root,
        "setup",
        [
          "#!/usr/bin/env bun",
          "console.log('setup one')",
          "console.error('setup two')",
          "console.log('setup three')",
          "console.error('setup four')",
          "",
        ].join("\n"),
      )

      const lines = await Effect.runPromise(
        LifecycleHooks.runSetup(root).pipe(Stream.runCollect, Effect.provide(LifecycleHooks.layer)),
      )

      expect(lines).toHaveLength(4)
      expect(lines.filter((line) => line.source === "stdout").map((line) => line.line)).toEqual([
        "setup one",
        "setup three",
      ])
      expect(lines.filter((line) => line.source === "stderr").map((line) => line.line)).toEqual([
        "setup two",
        "setup four",
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("runSetup emits a final line without a trailing newline", async () => {
    const root = await tempRoot()
    try {
      await writeHook(root, "setup", "#!/usr/bin/env bun\nprocess.stdout.write('partial')\n")

      const lines = await Effect.runPromise(
        LifecycleHooks.runSetup(root).pipe(Stream.runCollect, Effect.provide(LifecycleHooks.layer)),
      )

      expect(lines).toEqual([{ source: "stdout", line: "partial" }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("runSetup fails on non-zero exit with exit code and last fifty output lines", async () => {
    const root = await tempRoot()
    try {
      await writeHook(
        root,
        "setup",
        [
          "#!/usr/bin/env bun",
          "for (let index = 1; index <= 55; index += 1) console.log(`line-${index}`)",
          "process.exit(7)",
          "",
        ].join("\n"),
      )

      const error = await Effect.runPromise(
        LifecycleHooks.runSetup(root).pipe(Stream.runCollect, Effect.flip, Effect.provide(LifecycleHooks.layer)),
      )

      expect(error.hook).toBe("setup")
      expect(error.exitCode).toBe(7)
      expect(error.lastOutput?.map((line) => line.line)).toEqual(
        Array.from({ length: 50 }, (_, index) => `line-${index + 6}`),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("missing hooks skip without failing", async () => {
    const root = await tempRoot()
    try {
      const setupLines = await Effect.runPromise(
        LifecycleHooks.runSetup(root).pipe(Stream.runCollect, Effect.provide(LifecycleHooks.layer)),
      )
      const resume = await Effect.runPromise(LifecycleHooks.runResume(root).pipe(Effect.provide(LifecycleHooks.layer)))

      expect(setupLines).toEqual([])
      expect(resume).toEqual({ status: "skipped" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("runSetup accepts a relative workspace root", async () => {
    const root = await tempRoot()
    try {
      await writeHook(root, "setup", "#!/usr/bin/env bun\nconsole.log(process.cwd())\n")

      const relativeRoot = relativeFromCwd(root)
      const lines = await Effect.runPromise(
        LifecycleHooks.runSetup(relativeRoot).pipe(Stream.runCollect, Effect.provide(LifecycleHooks.layer)),
      )

      expect(lines).toEqual([{ source: "stdout", line: await realpath(root) }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("runResume accepts a relative workspace root", async () => {
    const root = await tempRoot()
    const cwdPath = join(root, "resume.cwd")
    try {
      await writeHook(
        root,
        "resume",
        ["#!/usr/bin/env bun", `await Bun.write(${JSON.stringify(cwdPath)}, process.cwd())`, ""].join("\n"),
      )

      const relativeRoot = relativeFromCwd(root)
      const result = await Effect.runPromise(
        LifecycleHooks.runResume(relativeRoot).pipe(Effect.provide(LifecycleHooks.layer)),
      )

      expect(result).toEqual({ status: "ok" })
      expect(await readFile(cwdPath, "utf8")).toBe(await realpath(root))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("present hooks must be executable", async () => {
    const root = await tempRoot()
    try {
      await writeHook(root, "setup", "#!/usr/bin/env bun\nconsole.log('no')\n", 0o644)
      await writeHook(root, "resume", "#!/usr/bin/env bun\nconsole.log('no')\n", 0o644)

      const setupError = await Effect.runPromise(
        LifecycleHooks.runSetup(root).pipe(Stream.runCollect, Effect.flip, Effect.provide(LifecycleHooks.layer)),
      )
      const resumeError = await Effect.runPromise(
        LifecycleHooks.runResume(root).pipe(Effect.flip, Effect.provide(LifecycleHooks.layer)),
      )

      expect(setupError.hook).toBe("setup")
      expect(setupError.message).toContain("executable")
      expect(resumeError.hook).toBe("resume")
      expect(resumeError.message).toContain("executable")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("runResume reports ok and failed statuses", async () => {
    const root = await tempRoot()
    try {
      await writeHook(root, "resume", "#!/usr/bin/env bun\nprocess.exit(0)\n")
      const ok = await Effect.runPromise(LifecycleHooks.runResume(root).pipe(Effect.provide(LifecycleHooks.layer)))
      expect(ok).toEqual({ status: "ok" })

      await writeHook(root, "resume", "#!/usr/bin/env bun\nprocess.exit(9)\n")
      const failed = await Effect.runPromise(LifecycleHooks.runResume(root).pipe(Effect.provide(LifecycleHooks.layer)))
      expect(failed).toEqual({ status: "failed", exitCode: 9 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("runResume returns detached on timeout without waiting for the child", async () => {
    const root = await tempRoot()
    const pidPath = join(root, "resume.pid")
    let pid: number | undefined
    try {
      await writeHook(
        root,
        "resume",
        [
          "#!/usr/bin/env bun",
          `await Bun.write(${JSON.stringify(pidPath)}, String(process.pid))`,
          "await Bun.sleep(30000)",
          "",
        ].join("\n"),
      )

      const started = Date.now()
      const result = await Effect.runPromise(
        LifecycleHooks.runResume(root).pipe(
          Effect.provide(LifecycleHooks.layerWithOptions({ resumeTimeout: "50 millis" })),
        ),
      )
      const elapsed = Date.now() - started

      expect(result).toEqual({ status: "detached" })
      expect(elapsed).toBeLessThan(1_000)

      const livePid = Number(await waitForText(pidPath))
      pid = livePid
      expect(() => process.kill(livePid, 0)).not.toThrow()
      process.kill(livePid, "SIGTERM")
    } finally {
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGTERM")
        } catch {}
      }
      await rm(root, { recursive: true, force: true })
    }
  })
})

const writeHook = async (root: string, name: "setup" | "resume", contents: string, mode = 0o755) => {
  const directory = join(root, ".agents")
  await mkdir(directory, { recursive: true })
  const path = join(directory, name)
  await writeFile(path, contents)
  await chmod(path, mode)
  return path
}

const waitForText = async (path: string) => {
  const deadline = Date.now() + 1_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8")
    } catch (error) {
      lastError = error
      await Bun.sleep(10)
    }
  }
  throw lastError
}

const relativeFromCwd = (path: string) => {
  return relative(process.cwd(), path)
}
