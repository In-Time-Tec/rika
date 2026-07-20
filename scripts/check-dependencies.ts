import { Data, Effect, FileSystem, Layer, Schema } from "effect"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"

const PackageJson = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  workspaces: Schema.optionalKey(
    Schema.Struct({
      packages: Schema.Array(Schema.String),
    }),
  ),
})

const forbiddenProtocols = ["file:", "link:"] as const
const externalFrameworks = new Set([
  "@batonfx/core",
  "@batonfx/mcp",
  "@batonfx/providers",
  "@batonfx/skills",
  "@batonfx/test",
  "@relayfx/sdk",
])
const languageModelProviderPackages = new Set([
  "@anthropic-ai/sdk",
  "@aws-sdk/client-bedrock-runtime",
  "@batonfx/providers",
  "@google/generative-ai",
  "@google/genai",
  "@mistralai/mistralai",
  "cohere-ai",
  "groq-sdk",
  "openai",
])
const isLanguageModelProviderPackage = (name: string) =>
  languageModelProviderPackages.has(name) || name.startsWith("@ai-sdk/")

type PackageManifest = typeof PackageJson.Type
type NamedManifest = { readonly path: string; readonly manifest: PackageManifest }

const allDependencies = (manifest: PackageManifest) => ({
  ...manifest.dependencies,
  ...manifest.devDependencies,
  ...manifest.optionalDependencies,
  ...manifest.peerDependencies,
})

export const checkDependencyManifests = (manifests: ReadonlyArray<NamedManifest>) =>
  manifests.flatMap(({ path, manifest }) =>
    Object.entries(allDependencies(manifest)).flatMap(([name, version]) => {
      if (forbiddenProtocols.some((protocol) => version.startsWith(protocol)))
        return [`${path}: ${name} uses ${version}`]
      if (externalFrameworks.has(name) && version.startsWith("workspace:"))
        return [`${path}: ${name} uses external workspace linking`]
      if (manifest.name === "@rika/tools" && isLanguageModelProviderPackage(name))
        return [`${path}: @rika/tools cannot depend on language-model provider ${name}`]
      return []
    }),
  )

const workspaceManifestPaths = (patterns: ReadonlyArray<string>) =>
  Effect.sync(() => [
    "package.json",
    ...patterns.flatMap((pattern) => Array.from(new Bun.Glob(`${pattern}/package.json`).scanSync({ onlyFiles: true }))),
  ])

class DependencyCheckError extends Data.TaggedError("DependencyCheckError")<{ readonly message: string }> {}

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(PackageJson))
  const root = yield* fileSystem.readFileString("package.json").pipe(Effect.flatMap(decode))
  const paths = yield* workspaceManifestPaths(root.workspaces?.packages ?? [])
  const manifests = yield* Effect.forEach(paths, (path) =>
    fileSystem.readFileString(path).pipe(
      Effect.flatMap(decode),
      Effect.map((manifest) => ({ path, manifest })),
    ),
  )
  const violations = checkDependencyManifests(manifests)
  if (violations.length > 0) return yield* new DependencyCheckError({ message: violations.join("\n") })
})

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(program, context))),
  )
