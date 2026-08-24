import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import * as os from "node:os"
import { Config, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { defineConfig } from "vitest/config"
import { CompletionReporter } from "./test/support/vitest-run-completeness-reporter"

/**
 * Half the machine's cores, bounded so a laptop gets real parallelism while a four-core CI
 * runner never oversubscribes into starvation timeouts on timing-sensitive tests.
 */
const laneWorkers = (cap: number) => Math.min(cap, Math.max(2, Math.ceil(os.cpus().length / 2)))
const platform = Layer.merge(BunFileSystem.layer, BunPath.layer)
const runPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>, layer: Layer.Layer<R, E>) =>
  Effect.scoped(Layer.build(layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context)))).pipe(
    Effect.runSync,
  )
const configured = Effect.gen(function* () {
  const path = yield* Path.Path
  const tenetkit = yield* Config.option(Config.string("RIKA_TENETKIT_WORKTREE"))
  return { path, tenetkit }
}).pipe((effect) => runPlatform(effect, platform))
const tenetkit = configured.tenetkit._tag === "Some" ? configured.tenetkit.value : undefined
const resolve = configured.path.resolve
const dirname = configured.path.dirname
const tenetkitPackage = tenetkit === undefined ? undefined : resolve(tenetkit, "packages/tenetkit/dist")
const tenetkitAliases =
  tenetkitPackage === undefined
    ? []
    : [
        { find: /^tenetkit$/, replacement: resolve(tenetkitPackage, "index.js") },
        { find: /^tenetkit\/ai$/, replacement: resolve(tenetkitPackage, "ai/index.js") },
        { find: /^tenetkit\/harness$/, replacement: resolve(tenetkitPackage, "harness/index.js") },
        { find: /^tenetkit\/mcp$/, replacement: resolve(tenetkitPackage, "mcp/index.js") },
        { find: /^tenetkit\/repl$/, replacement: resolve(tenetkitPackage, "repl/index.js") },
        { find: /^tenetkit\/repl\/bun$/, replacement: resolve(tenetkitPackage, "repl/repl/bun.js") },
        { find: /^tenetkit\/runtime$/, replacement: resolve(tenetkitPackage, "runtime/index.js") },
        { find: /^tenetkit\/runtime\/driver$/, replacement: resolve(tenetkitPackage, "runtime/driver/index.js") },
        {
          find: /^tenetkit\/runtime\/driver\/sql\/codecs$/,
          replacement: resolve(tenetkitPackage, "runtime/sql/codecs.js"),
        },
        { find: /^tenetkit\/skills$/, replacement: resolve(tenetkitPackage, "skills/index.js") },
        { find: /^tenetkit\/test$/, replacement: resolve(tenetkitPackage, "test/index.js") },
        { find: /^@tenetkit\/pg$/, replacement: resolve(tenetkit, "packages/pg/dist/postgres/index.js") },
      ]
export default defineConfig({
  resolve: {
    dedupe: ["effect"],
    alias: tenetkitAliases,
  },
  plugins: [
    {
      name: "prompt-text",
      enforce: "pre",
      resolveId(id, importer) {
        if (!id.endsWith(".prompt.txt")) return undefined
        return importer === undefined ? id : resolve(dirname(importer), id)
      },
      load(id) {
        if (!id.endsWith(".prompt.txt")) return undefined
        return Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const content = yield* fileSystem.readFileString(id)
          const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(content)
          return `export default ${encoded}`
        }).pipe((effect) =>
          Effect.scoped(
            Layer.build(BunFileSystem.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context))),
          ).pipe(Effect.runPromise),
        )
      },
    },
  ],
  test: {
    reporters: ["default", new CompletionReporter()],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          testTimeout: 20_000,
          include: [
            "packages/*/src/**/*.test.ts",
            "packages/*/test/**/*.test.ts",
            "apps/*/src/**/*.test.ts",
            "apps/*/test/**/*.test.ts",
            "tooling/*/src/**/*.test.ts",
            "test/**/*.test.ts",
          ],
          exclude: ["**/*.native.test.ts", "**/*.journey.test.ts", "**/*.tui.test.ts", "**/*.proc.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "tui",
          include: ["apps/*/test/**/*.tui.test.ts"],
          passWithNoTests: true,
          fileParallelism: true,
          maxWorkers: laneWorkers(5),
          testTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: "proc",
          include: [
            "packages/*/test/**/*.proc.test.ts",
            "apps/*/test/**/*.proc.test.ts",
            "test/process/**/*.proc.test.ts",
            "test/release/**/*.proc.test.ts",
          ],
          fileParallelism: true,
          maxWorkers: laneWorkers(6),
        },
      },
    ],
    coverage: {
      enabled: false,
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
      include: ["apps/*/src/**/*.ts", "packages/*/src/**/*.ts"],
      exclude: ["apps/*/src/main.ts", "**/node_modules/**", "**/dist/**"],
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
    },
  },
})
