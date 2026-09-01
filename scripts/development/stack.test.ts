import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { ensureRemoteStage, parseRemoteStage, readRemoteStage, remoteStageIdentity } from "./stack"

const live = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context))))

const readRepositoryText = Effect.fn("DevelopmentStackTest.readRepositoryText")(function* (relativePath: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.resolve(new URL("../..", import.meta.url).pathname)
  return yield* fileSystem.readFileString(path.join(root, relativePath))
})

it.effect("creates one persistent private personal Railway stage", () =>
  live(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-railway-stage-" })
      const first = yield* ensureRemoteStage(root)
      const second = yield* ensureRemoteStage(root)
      const identity = path.join(root, remoteStageIdentity)

      expect(first).toMatch(/^dev-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
      expect(second).toBe(first)
      expect((yield* fileSystem.readFileString(identity)).trim()).toBe(first)
      expect((yield* fileSystem.stat(path.join(root, ".alchemy"))).mode & 0o777).toBe(0o700)
      expect((yield* fileSystem.stat(identity)).mode & 0o777).toBe(0o600)
    }),
  ),
)

it.effect("refuses protected and malformed remote stage identities", () =>
  live(
    Effect.gen(function* () {
      for (const stage of [
        "production",
        "staging",
        "pr-42",
        "dev-user",
        "dev-ABCDEF0123456789",
        "dev-01234567-89ab-1cde-8fab-0123456789ab",
      ])
        expect(() => parseRemoteStage(stage)).toThrow()

      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-railway-stage-" })
      yield* ensureRemoteStage(root)
      yield* fileSystem.writeFileString(path.join(root, remoteStageIdentity), "production\n")
      const error = yield* Effect.flip(readRemoteStage(root))
      expect(String(error)).toContain("protected Railway stage")
    }),
  ),
)

it.effect("rejects a symbolic-link stage identity", () =>
  live(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-railway-stage-" })
      const target = path.join(root, "stage-target")
      yield* fileSystem.writeFileString(target, "dev-01234567-89ab-4cde-8fab-0123456789ab\n", { mode: 0o600 })
      yield* fileSystem.makeDirectory(path.join(root, ".alchemy"), { mode: 0o700 })
      yield* fileSystem.symlink(target, path.join(root, remoteStageIdentity))
      const error = yield* Effect.flip(readRemoteStage(root))
      expect(String(error)).toContain("symbolic link")

      const parentRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-railway-stage-parent-" })
      const redirected = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-railway-stage-redirected-" })
      yield* fileSystem.writeFileString(
        path.join(redirected, "rika-dev-stage"),
        "dev-01234567-89ab-4cde-8fab-0123456789ab\n",
        { mode: 0o600 },
      )
      yield* fileSystem.chmod(redirected, 0o755)
      yield* fileSystem.symlink(redirected, path.join(parentRoot, ".alchemy"))
      const ensureParentError = yield* Effect.flip(ensureRemoteStage(parentRoot))
      expect(String(ensureParentError)).toContain("symbolic link")
      expect((yield* fileSystem.stat(redirected)).mode & 0o777).toBe(0o755)
      const parentError = yield* Effect.flip(readRemoteStage(parentRoot))
      expect(String(parentError)).toContain("symbolic link")
    }),
  ),
)

it.effect("concurrent starts adopt the same complete stage identity", () =>
  live(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-railway-stage-" })
      const stages = yield* Effect.all(
        Array.from({ length: 8 }, () => ensureRemoteStage(root)),
        { concurrency: 8 },
      )
      expect(new Set(stages)).toEqual(new Set([stages[0]]))
    }),
  ),
)

it.effect("reading for destroy fails closed without creating an identity", () =>
  live(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-railway-stage-" })
      expect((yield* Effect.exit(readRemoteStage(root)))._tag).toBe("Failure")
      expect(yield* fileSystem.exists(path.join(root, remoteStageIdentity))).toBe(false)
    }),
  ),
)

it.effect("pins the exact Alchemy Railway snapshot and keeps its optional website peer unloaded", () =>
  live(
    Effect.gen(function* () {
      const manifest = yield* readRepositoryText("package.json")
      const stack = yield* readRepositoryText("alchemy.run.ts")
      expect(manifest).toContain('"alchemy": "https://pkg.ing/alchemy/59573d7"')
      expect(stack).not.toContain('from "alchemy/Railway"')
      for (const module of ["Bucket", "Postgres", "Project", "Providers", "Service", "ref"])
        expect(stack).toContain(`from "alchemy/Railway/${module}"`)
    }),
  ),
)

it.effect("declares the isolated proxy-only public Railway topology", () =>
  live(
    Effect.gen(function* () {
      const stack = yield* readRepositoryText("alchemy.run.ts")
      const remote = stack.slice(stack.indexOf("const railwayStack"))
      expect(remote.match(/context: "\."/g)).toHaveLength(3)
      expect(remote.match(/publicDomain: false/g)).toHaveLength(2)
      expect(remote.match(/publicDomain: true/g)).toHaveLength(1)
      expect(remote).toContain("public: false")
      expect(remote).toContain('image: "ghcr.io/railwayapp-templates/postgres-ssl:17"')
      expect(remote).toContain('dockerfilePath: "apps/api/Dockerfile"')
      expect(remote).toContain('dockerfilePath: "apps/web/Dockerfile"')
      expect(remote).toContain('dockerfilePath: "apps/proxy/Dockerfile"')
      expect(remote).toContain('preDeploy: { command: "bun --cwd apps/api migrate" }')
      expect(remote).toContain(
        'const databaseUrl = Output.map(Output.of(postgres), () => railwayRef("postgres", "DATABASE_URL"))',
      )
      expect(remote).toContain(
        'const proxyDomain = requireOutput("the proxy public domain", proxy.domain, "destroy.invalid")',
      )
      expect(remote).toContain("AWS_SECRET_ACCESS_KEY: bucketSecretKey")
      expect(remote).toContain("workspaceId: inputs.provisioning.RAILWAY_WORKSPACE_ID")
      expect(remote).toContain('"the Storage Bucket secret key"')
      expect(remote).toContain("bucket.secretAccessKey")
      expect(remote).toContain("stage !== personalRailwayStage")
      expect(remote).toContain("E2B_DEPLOYMENT_ID: `rika-${stage}`")
      expect(remote).not.toMatch(/OPENROUTER|RIKA_DEV_SEED|RAILWAY_API_TOKEN|RAILWAY_TOKEN/)
    }),
  ),
)

const RootManifest = Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) })

it.effect("keeps root operational commands pointed directly at their owners", () =>
  live(
    Effect.gen(function* () {
      const manifest = yield* readRepositoryText("package.json").pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RootManifest))),
      )
      expect(manifest.scripts.dev).toBe("bun run scripts/development/stack.ts local")
      expect(manifest.scripts["dev:remote"]).toBe("bun run scripts/development/stack.ts remote")
      expect(manifest.scripts["dev:remote:destroy"]).toBe("bun run scripts/development/stack.ts destroy")
      expect(manifest.scripts.package).toBe("bun run scripts/packaging/package-target.ts")
      expect(manifest.scripts["npm-package"]).toBe("bun run scripts/packaging/npm-package.ts")
    }),
  ),
)

it.effect("keeps package target selection at the caller boundary", () =>
  live(
    Effect.gen(function* () {
      const manifest = yield* readRepositoryText("package.json").pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RootManifest))),
      )
      expect(manifest.scripts.package).toContain("package-target.ts")
      expect(manifest.scripts.package).not.toContain("--target")
    }),
  ),
)
