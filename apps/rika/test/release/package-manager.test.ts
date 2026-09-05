import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Layer, Path } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { HttpClient } from "effect/unstable/http"
import { packageInstall } from "../../src/release/package-manager"
import { update, updateReport } from "../../src/release/update"

const live = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context)))).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Package updates must not fetch GitHub archives")),
    ),
  )

const installed = Effect.fn("PackageUpdateTest.installed")(function* (manager: "npm" | "bun", nested: boolean) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-package-update-" }).pipe(Effect.flatMap(fs.realPath))
  const directory = manager === "npm" ? root : path.join(root, "custom-global")
  const modules = path.join(directory, ...(manager === "npm" ? ["lib"] : []), "node_modules")
  const launcher = path.join(modules, "@rikafx", "cli")
  const platform = path.join(nested ? path.join(launcher, "node_modules") : modules, "@rikafx", "cli-linux-x64")
  const executable = path.join(platform, "bin", "rika")
  const manifest = path.join(launcher, "package.json")
  yield* fs.makeDirectory(path.dirname(executable), { recursive: true })
  yield* fs.makeDirectory(launcher, { recursive: true })
  yield* fs.writeFileString(executable, "old binary")
  yield* fs.writeFileString(manifest, '{"name":"@rikafx/cli","version":"0.0.3"}')
  if (manager === "bun") {
    yield* fs.writeFileString(path.join(directory, "bun.lock"), "{}")
    yield* fs.writeFileString(path.join(directory, "package.json"), '{"dependencies":{"@rikafx/cli":"0.0.3"}}')
  }
  return { directory, manifest, executable }
})

it.effect("updates npm and Bun installs in their owning directory without downloading GitHub archives", () =>
  live(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      for (const manager of ["npm", "bun"] as const) {
        const install = yield* installed(manager, manager === "npm")
        const commands: Array<ChildProcess.Command> = []
        const result = yield* update({
          currentVersion: "0.0.3",
          executable: install.executable,
          host: { platform: "linux", architecture: "x64" },
        }).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({ env: { RIKA_INSTALL_ROOT: "/unrelated/install" } }),
          ),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
            ...spawner,
            exitCode: (command) =>
              Effect.gen(function* () {
                commands.push(command)
                yield* fs.writeFileString(install.manifest, '{"name":"@rikafx/cli","version":"0.0.4"}')
                return ChildProcessSpawner.ExitCode(0)
              }),
          }),
        )
        expect(result).toEqual({
          _tag: "PackageUpdated",
          current: "0.0.3",
          latest: "0.0.4",
          manager,
          installRoot: install.directory,
        })
        expect(commands).toHaveLength(1)
        const command = commands[0]
        expect(command?._tag).toBe("StandardCommand")
        if (command?._tag === "StandardCommand") {
          expect(command.command).toBe(manager)
          expect(command.options.cwd).toBe(install.directory)
          expect(command.args).toEqual(
            manager === "npm"
              ? ["install", "--global", "--prefix", install.directory, "@rikafx/cli@latest"]
              : ["add", "--cwd", install.directory, "@rikafx/cli@latest"],
          )
        }
        expect(yield* fs.readFileString(install.executable)).toBe("old binary")
        expect(updateReport(result)).toContain(`${manager} updated Rika`)
        expect(updateReport(result)).not.toContain("SHA256")
      }
    }),
  ),
)

it.effect("does not report success when the owning package manager fails", () =>
  live(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const install = yield* installed("bun", false)
      const result = yield* Effect.result(
        update({
          currentVersion: "0.0.3",
          executable: install.executable,
          host: { platform: "linux", architecture: "x64" },
        }),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
          ...spawner,
          exitCode: () => Effect.succeed(ChildProcessSpawner.ExitCode(23)),
        }),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.message).toContain("bun could not update")
        expect(result.failure.message).toContain("exit 23")
      }
    }),
  ),
)

it.effect("recognizes package-managed binaries through symlinks and legacy Bun lockfiles", () =>
  live(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const install = yield* installed("bun", false)
      yield* fs.rename(path.join(install.directory, "bun.lock"), path.join(install.directory, "bun.lockb"))
      const link = path.join(install.directory, "rika")
      yield* fs.symlink(install.executable, link)
      expect(yield* packageInstall(link)).toMatchObject({ manager: "bun", directory: install.directory })
    }),
  ),
)

it.effect("refuses a missing package root instead of letting Bun update a parent project", () =>
  live(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const install = yield* installed("bun", false)
      yield* fs.remove(path.join(install.directory, "package.json"))
      const error = yield* Effect.flip(packageInstall(install.executable))
      expect(error.failure).toBe("unmanaged-install")
      expect(error.message).toContain("refusing to update a parent project")
    }),
  ),
)

it.effect("keeps local npm updates local instead of installing another global copy", () =>
  live(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const install = yield* installed("bun", false)
      yield* fs.remove(path.join(install.directory, "bun.lock"))
      yield* fs.writeFileString(path.join(install.directory, "package-lock.json"), "{}")
      expect(yield* packageInstall(install.executable)).toMatchObject({
        manager: "npm",
        directory: install.directory,
        global: false,
      })
    }),
  ),
)
