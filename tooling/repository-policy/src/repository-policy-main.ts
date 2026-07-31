import { Console, Effect, Layer, Schema } from "effect"
import { FileSystem } from "effect/FileSystem"
import { Path } from "effect/Path"
import { Command, Argument } from "effect/unstable/cli"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import {
  applyBaselineAndWaivers,
  checkManifests,
  checkWorkspaceTestTopology,
  readWorkspaceManifests,
  scanSourcePolicies,
  validateWaivers,
  validateOwnershipExceptions,
  type BaselineInventory,
  type PolicyDiagnostic,
} from "./package-boundary-policy"

class PolicyError extends Schema.TaggedErrorClass<PolicyError>()("RepositoryPolicyError", { message: Schema.String }) {}

const formatDiagnostic = (item: PolicyDiagnostic) =>
  `${item.severity}: ${item.path}: ${item.rule}: ${item.message}. Remediation: ${item.remediation}`

const readJson = Effect.fn("RepositoryPolicy.readJson")(function* <A>(filePath: string) {
  const fileSystem = yield* FileSystem
  return (yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(
    yield* fileSystem.readFileString(filePath),
  )) as A
})

const checkedInOutputDiagnostics = Effect.fn("RepositoryPolicy.checkedInOutputDiagnostics")(function* (root: string) {
  const fileSystem = yield* FileSystem
  const path = yield* Path
  const JavaScriptFiles = yield* fileSystem.glob("{apps,packages,scripts,test,tooling}/**/*.{js,jsx,mjs,cjs}", {
    root,
    exclude: ["**/node_modules/**", "**/dist/**"],
  })
  const diagnostics: PolicyDiagnostic[] = []
  for (const file of JavaScriptFiles) {
    const source = file.replace(/\.(?:jsx?|mjs|cjs)$/, ".ts")
    const absoluteFile = path.isAbsolute(file) ? file : path.join(root, file)
    const absoluteSource = path.isAbsolute(source) ? source : path.join(root, source)
    if (yield* fileSystem.exists(absoluteSource))
      diagnostics.push({
        path: path.relative(root, absoluteFile),
        rule: "checked-in-output",
        severity: "error",
        message: "compiled JavaScript is checked in beside TypeScript",
        remediation: "Remove the generated file and keep executable output under a named build directory",
      })
  }
  return diagnostics
})

const run = Effect.fn("RepositoryPolicy.run")(function* () {
  const path = yield* Path
  const root = path.resolve(import.meta.dirname, "../../..")
  const manifests = yield* readWorkspaceManifests(path.join(root, "package.json"))
  const sourceDiagnostics = yield* scanSourcePolicies(root)
  const outputDiagnostics = yield* checkedInOutputDiagnostics(root)
  const rawWaivers = yield* readJson<unknown>(path.join(root, "tooling/repository-policy/migration-waivers.json"))
  const waivers = validateWaivers(rawWaivers)
  const rawExceptions = yield* readJson<unknown>(
    path.join(root, "tooling/repository-policy/test-ownership-exceptions.json"),
  )
  const ownershipExceptions = validateOwnershipExceptions(rawExceptions)
  const baseline = yield* readJson<BaselineInventory>(
    path.join(root, "tooling/repository-policy/baseline-inventory.json"),
  )
  if (baseline.base !== "19a8a4b" || !Array.isArray(baseline.paths) || !Array.isArray(baseline.entries))
    return yield* PolicyError.make({ message: "baseline inventory must be pinned to 19a8a4b" })
  const diagnostics = applyBaselineAndWaivers({
    diagnostics: [
      ...checkManifests(manifests),
      ...sourceDiagnostics,
      ...outputDiagnostics,
      ...(yield* checkWorkspaceTestTopology(root, ownershipExceptions)),
    ],
    baseline,
    waivers,
  })
  const errors = diagnostics.filter((item) => item.severity === "error")
  if (errors.length > 0) return yield* PolicyError.make({ message: errors.map(formatDiagnostic).join("\n") })
  yield* Console.log(
    `repository policy passed: ${manifests.length} manifests, ${diagnostics.length} diagnostics, ${waivers.length} waivers`,
  )
})

const command = Command.make("repository-policy", { args: Argument.variadic(Argument.string("argument")) }, () => run())
if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(
      Effect.flatMap(Layer.build(BunServices.layer), (context) =>
        Effect.provide(Command.run(command, { version: "0.0.0" }), context),
      ),
    ),
  )
