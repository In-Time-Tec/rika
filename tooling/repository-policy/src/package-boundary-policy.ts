import { Effect, Schema } from "effect"
import { FileSystem } from "effect/FileSystem"
import { Path } from "effect/Path"
import { parse } from "@typescript-eslint/parser"

export type PackageManifest = {
  readonly name?: string
  readonly dependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
  readonly optionalDependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly scripts?: Record<string, string>
  readonly exports?: Record<string, string | Record<string, string>>
  readonly rika?: { readonly kind?: string; readonly domain?: string }
}
export type NamedManifest = { readonly path: string; readonly manifest: PackageManifest }
export type PolicySeverity = "error" | "warning"
export type PolicyDiagnostic = {
  readonly path: string
  readonly rule: string
  readonly severity: PolicySeverity
  readonly message: string
  readonly remediation: string
}
export type MigrationWaiver = {
  readonly rule: string
  readonly paths: ReadonlyArray<string>
  readonly removalSlice: number
  readonly reason: string
}
export type TestOwnershipException = {
  readonly sourcePath: string
  readonly testPath: string
  readonly relationship: "direct" | "public-api" | "integration" | "process"
  readonly reason: string
}
export type BaselineInventory = {
  readonly base: "19a8a4b"
  readonly paths: ReadonlyArray<string>
  readonly entries: ReadonlyArray<Pick<PolicyDiagnostic, "path" | "rule" | "severity" | "message">>
}

const forbiddenProtocols = ["file:", "link:"] as const
const autoresearchLinkPrefix = "file:/private/tmp/rika-autoresearch-links/"
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
const validKinds = new Set(["domain", "capability", "adapter", "application", "tooling"])
const allowedPackageEdges: Readonly<Record<string, ReadonlySet<string>>> = {
  "@rika/coding-tools": new Set(["@rika/configuration"]),
  "@rika/transcript": new Set(["@rika/coding-tools"]),
  "@rika/product-store": new Set(["@rika/product", "@rika/transcript"]),
  "@rika/relay-execution": new Set(["@rika/configuration", "@rika/coding-tools", "@rika/product"]),
  "@rika/product": new Set(["@rika/configuration", "@rika/extensions", "@rika/coding-tools", "@rika/transcript"]),
  "@rika/terminal": new Set(["@rika/configuration", "@rika/transcript"]),
  "@rika/cli": new Set([
    "@rika/configuration",
    "@rika/extensions",
    "@rika/product-store",
    "@rika/relay-execution",
    "@rika/coding-tools",
    "@rika/transcript",
    "@rika/product",
    "@rika/terminal",
  ]),
}
const allDependencies = (manifest: PackageManifest) => [
  ...Object.entries(manifest.dependencies ?? {}).map(([name, version]) => [name, version, "dependencies"] as const),
  ...Object.entries(manifest.devDependencies ?? {}).map(
    ([name, version]) => [name, version, "devDependencies"] as const,
  ),
  ...Object.entries(manifest.optionalDependencies ?? {}).map(
    ([name, version]) => [name, version, "optionalDependencies"] as const,
  ),
  ...Object.entries(manifest.peerDependencies ?? {}).map(
    ([name, version]) => [name, version, "peerDependencies"] as const,
  ),
]
const isProvider = (name: string) => languageModelProviderPackages.has(name) || name.startsWith("@ai-sdk/")
const isForbiddenLocalLink = (version: string) =>
  forbiddenProtocols.some((protocol) => version.startsWith(protocol)) && !version.startsWith(autoresearchLinkPrefix)
const diagnostic = (
  path: string,
  rule: string,
  message: string,
  remediation: string,
  severity: PolicySeverity = "error",
): PolicyDiagnostic => ({ path, rule, severity, message, remediation })

export const checkDependencyManifests = (manifests: ReadonlyArray<NamedManifest>): string[] =>
  manifests.flatMap(({ path, manifest }) =>
    allDependencies(manifest).flatMap(([name, version]) => {
      if (isForbiddenLocalLink(version)) return [`${path}: ${name} uses ${version}`]
      if (externalFrameworks.has(name) && version.startsWith("workspace:"))
        return [`${path}: ${name} uses external workspace linking`]
      if (manifest.name === "@rika/coding-tools" && isProvider(name))
        return [`${path}: @rika/coding-tools cannot depend on language-model provider ${name}`]
      return []
    }),
  )

export const checkPackageMetadata = (manifests: ReadonlyArray<NamedManifest>): PolicyDiagnostic[] =>
  manifests.flatMap(({ path, manifest }) => {
    const metadata = manifest.rika
    if (metadata === undefined)
      return [
        diagnostic(
          path,
          "package-kind",
          "package is missing rika.kind and rika.domain metadata",
          "Add rika.kind and rika.domain to the package manifest",
        ),
      ]
    if (metadata.kind === undefined || !validKinds.has(metadata.kind))
      return [
        diagnostic(
          path,
          "package-kind",
          `package kind ${metadata.kind ?? "<missing>"} is not allowed`,
          "Set rika.kind to domain, capability, adapter, application, or tooling",
        ),
      ]
    if (metadata.domain === undefined || metadata.domain.trim() === "")
      return [
        diagnostic(path, "package-domain", "package domain is missing", "Set rika.domain to the owned capability name"),
      ]
    return []
  })

const exportTarget = (value: string | Record<string, string>) =>
  typeof value === "string" ? value : (value.import ?? value.default ?? value.require ?? Object.values(value)[0])
export const checkExportMaps = (manifests: ReadonlyArray<NamedManifest>): PolicyDiagnostic[] =>
  manifests.flatMap(({ path, manifest }) => {
    const packageName = manifest.name
    if (packageName === undefined || manifest.exports === undefined) return []
    return Object.entries(manifest.exports).flatMap(([key, value]) => {
      const target = exportTarget(value)
      const publicName = key === "." ? packageName : key.slice(2)
      const publicLeaf = publicName.split("/").at(-1) ?? publicName
      const targetPath = target?.replace(/^\.\//, "")
      const targetBasename = targetPath
        ?.split("/")
        .pop()
        ?.replace(/\.[^.]+$/, "")
      if (
        key === "." ||
        target === undefined ||
        target.includes("dist/") ||
        targetPath === undefined ||
        targetBasename !== publicLeaf
      )
        return [
          diagnostic(
            path,
            "source-exports",
            `export ${key} does not target an existing source file named ${publicName}`,
            "Point the exact export subpath at a source module whose basename matches the public export",
          ),
        ]
      return []
    })
  })

export const checkScriptBoundaries = (manifests: ReadonlyArray<NamedManifest>): PolicyDiagnostic[] =>
  manifests.flatMap(({ path, manifest }) =>
    Object.entries(manifest.scripts ?? {}).flatMap(([name, command]) => {
      if (name.includes(":"))
        return [
          diagnostic(
            path,
            "colon-script",
            `script ${name} uses a colon alias`,
            "Expose one descriptive command without a colon-named dispatcher",
          ),
        ]
      if (/check-dependencies\.ts/.test(command))
        return [
          diagnostic(
            path,
            "obsolete-dependency-check",
            "manifest still invokes the replaced dependency checker",
            "Use the repository-policy workspace check",
          ),
        ]
      return []
    }),
  )

export const checkOutputPaths = (_manifests: ReadonlyArray<NamedManifest>): PolicyDiagnostic[] => []

export const checkSourceMetrics = (input: {
  readonly path: string
  readonly lines: number
  readonly exports: number
  readonly dependencies: number
  readonly functions?: ReadonlyArray<{ readonly name: string; readonly lines: number }>
}): PolicyDiagnostic[] => {
  const diagnostics: PolicyDiagnostic[] = []
  if (input.lines > 800)
    diagnostics.push(
      diagnostic(
        input.path,
        "file-size",
        `file has ${input.lines} lines`,
        "Split the file at a semantic boundary or name a temporary migration waiver",
      ),
    )
  else if (input.lines > 500)
    diagnostics.push(
      diagnostic(
        input.path,
        "file-size",
        `file has ${input.lines} lines`,
        "Keep changed files under 500 lines or name a temporary migration waiver",
        "warning",
      ),
    )
  if (input.exports > 8)
    diagnostics.push(
      diagnostic(
        input.path,
        "export-count",
        `file has ${input.exports} exported declarations`,
        "Move concepts into named semantic modules",
      ),
    )
  else if (input.exports > 4)
    diagnostics.push(
      diagnostic(
        input.path,
        "export-count",
        `file has ${input.exports} exported declarations`,
        "Keep files at four or fewer exported declarations",
        "warning",
      ),
    )
  if (input.dependencies > 18)
    diagnostics.push(
      diagnostic(
        input.path,
        "dependency-count",
        `file has ${input.dependencies} direct dependencies`,
        "Split the semantic unit or move the boundary",
      ),
    )
  else if (input.dependencies > 12)
    diagnostics.push(
      diagnostic(
        input.path,
        "dependency-count",
        `file has ${input.dependencies} direct dependencies`,
        "Keep direct dependencies at twelve or fewer",
        "warning",
      ),
    )
  for (const fn of input.functions ?? []) {
    if (fn.lines > 150)
      diagnostics.push(
        diagnostic(
          input.path,
          "function-size",
          `${fn.name} has ${fn.lines} lines`,
          "Split the function at a named transformation boundary",
        ),
      )
    else if (fn.lines > 80)
      diagnostics.push(
        diagnostic(
          input.path,
          "function-size",
          `${fn.name} has ${fn.lines} lines`,
          "Keep functions at eighty or fewer lines",
          "warning",
        ),
      )
  }
  return diagnostics
}

export const checkDirectoryMetrics = (input: {
  readonly path: string
  readonly sourceFiles: number
}): PolicyDiagnostic[] => {
  if (input.sourceFiles > 30)
    return [
      diagnostic(
        input.path,
        "directory-size",
        `directory has ${input.sourceFiles} source files`,
        "Create meaningful capability branches",
      ),
    ]
  if (input.sourceFiles > 20)
    return [
      diagnostic(
        input.path,
        "directory-size",
        `directory has ${input.sourceFiles} source files`,
        "Create meaningful capability branches",
        "warning",
      ),
    ]
  return []
}
export const checkTestTopology = (input: {
  readonly sourcePath: string
  readonly testPaths: ReadonlyArray<string>
  readonly exception?: string
}): PolicyDiagnostic[] =>
  input.testPaths.length > 0 || input.exception !== undefined
    ? []
    : [
        diagnostic(
          input.sourcePath,
          "test-topology",
          "source module has no same-stem or named broader test",
          "Add a colocated test or a named ownership exception",
          "warning",
        ),
      ]

export const checkPackageEdges = (manifests: ReadonlyArray<NamedManifest>): PolicyDiagnostic[] => {
  const names = new Set(
    manifests.map(({ manifest }) => manifest.name).filter((name): name is string => name !== undefined),
  )
  return manifests.flatMap(({ path, manifest }) => {
    const packageName = manifest.name
    if (packageName === undefined || !packageName.startsWith("@rika/") || manifest.rika?.kind === "tooling") return []
    return allDependencies(manifest).flatMap(([name, , section]) =>
      names.has(name) && allowedPackageEdges[packageName]?.has(name) !== true && section !== "devDependencies"
        ? [
            diagnostic(
              path,
              "package-edge",
              `${packageName} cannot depend on ${name}`,
              "Move the contract inward or use the owning package boundary",
            ),
          ]
        : [],
    )
  })
}

export const checkManifests = (manifests: ReadonlyArray<NamedManifest>): PolicyDiagnostic[] => [
  ...checkDependencyManifests(manifests).map((message) =>
    diagnostic(
      message.split(":")[0] ?? "package.json",
      "dependency-boundary",
      message,
      "Use a registry version, an approved local link, or the owning package boundary",
    ),
  ),
  ...checkPackageMetadata(manifests),
  ...checkExportMaps(manifests),
  ...checkScriptBoundaries(manifests),
  ...checkPackageEdges(manifests),
]

const sourceMetrics = (filePath: string, text: string): PolicyDiagnostic[] => {
  const source = parse(text, { filePath, loc: true, range: true, sourceType: "module" })
  const lineCount = source.loc.end.line
  const exported = source.body.reduce((count, statement) => {
    if (statement.type === "ExportNamedDeclaration" && statement.specifiers.length > 0)
      return count + statement.specifiers.length
    return statement.type === "ExportDefaultDeclaration" ||
      statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportAllDeclaration"
      ? count + 1
      : count
  }, 0)
  const imports = new Set(
    source.body.flatMap((statement) => {
      if (statement.type === "ImportDeclaration") return [statement.source.value]
      if (statement.type === "ExportNamedDeclaration" && statement.source !== null) return [statement.source.value]
      if (statement.type === "ExportAllDeclaration") return [statement.source.value]
      return []
    }),
  )
  const functions = source.body.flatMap((statement) => {
    if (statement.type !== "FunctionDeclaration" || statement.id === null || statement.loc === undefined) return []
    return [{ name: statement.id.name, lines: statement.loc.end.line - statement.loc.start.line + 1 }]
  })
  return checkSourceMetrics({
    path: filePath,
    lines: lineCount,
    exports: exported,
    dependencies: imports.size,
    functions,
  })
}

const invalidBasename = (filePath: string) => {
  const basename = filePath.split("/").pop() ?? ""
  if (basename === "index.ts" || basename === "index.tsx")
    return diagnostic(
      filePath,
      "basename",
      "index basenames are not semantic module names",
      "Rename the module to its domain role",
    )
  if (!/^[a-z0-9]+(?:-[a-z0-9]+){1,4}\.(?:tsx?|mts|cts)$/.test(basename) && !basename.endsWith(".test.ts"))
    return diagnostic(
      filePath,
      "basename",
      "source basename is not two-to-five-word kebab case",
      "Rename the file to a descriptive semantic role",
    )
  return undefined
}

export const validateOwnershipExceptions = (value: unknown): TestOwnershipException[] => {
  if (!Array.isArray(value))
    throw new Error("tooling/repository-policy/test-ownership-exceptions.json: expected an array")
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null)
      throw new Error(`test-ownership-exceptions.json[${index}]: expected an object`)
    const item = entry as Record<string, unknown>
    const relationship = item.relationship
    if (
      typeof item.sourcePath !== "string" ||
      typeof item.testPath !== "string" ||
      !["direct", "public-api", "integration", "process"].includes(String(relationship)) ||
      typeof item.reason !== "string" ||
      item.reason.trim() === "" ||
      item.sourcePath.includes("*") ||
      item.testPath.includes("*")
    )
      throw new Error(
        `test-ownership-exceptions.json[${index}]: sourcePath, testPath, relationship, and reason are required`,
      )
    return {
      sourcePath: item.sourcePath,
      testPath: item.testPath,
      relationship: relationship as TestOwnershipException["relationship"],
      reason: item.reason,
    }
  })
}

export const validateWaivers = (value: unknown): MigrationWaiver[] => {
  if (!Array.isArray(value))
    throw new Error("tooling/repository-policy/migration-waivers.json: expected an array of named migration waivers")
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null)
      throw new Error(`tooling/repository-policy/migration-waivers.json[${index}]: expected an object`)
    const item = entry as Record<string, unknown>
    const paths = item.paths
    if (
      typeof item.rule !== "string" ||
      item.rule.length === 0 ||
      !Array.isArray(paths) ||
      paths.length === 0 ||
      paths.some((pathValue) => typeof pathValue !== "string" || pathValue.includes("*")) ||
      typeof item.removalSlice !== "number" ||
      !Number.isInteger(item.removalSlice) ||
      typeof item.reason !== "string" ||
      item.reason.trim() === ""
    )
      throw new Error(
        `tooling/repository-policy/migration-waivers.json[${index}]: rule, exact paths, removalSlice, and reason are required`,
      )
    return { rule: item.rule, paths: paths as string[], removalSlice: item.removalSlice, reason: item.reason }
  })
}

export const applyBaselineAndWaivers = (input: {
  readonly diagnostics: ReadonlyArray<PolicyDiagnostic>
  readonly baseline: BaselineInventory
  readonly waivers: ReadonlyArray<MigrationWaiver>
}) =>
  input.diagnostics.filter((item) => {
    const baselineMatch =
      input.baseline.paths.includes(item.path) ||
      input.baseline.entries.some(
        (entry) =>
          entry.path === item.path &&
          entry.rule === item.rule &&
          entry.severity === item.severity &&
          entry.message === item.message,
      )
    const waiverMatch = input.waivers.some((waiver) => waiver.rule === item.rule && waiver.paths.includes(item.path))
    return !baselineMatch && !waiverMatch
  })

export const readWorkspaceManifests = Effect.fn("RepositoryPolicy.readWorkspaceManifests")(function* (
  rootPath = "package.json",
) {
  const fileSystem = yield* FileSystem
  const path = yield* Path
  const root = (yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(
    yield* fileSystem.readFileString(rootPath),
  )) as PackageManifest & { readonly workspaces?: { readonly packages?: ReadonlyArray<string> } }
  const rootDirectory = path.dirname(path.resolve(rootPath))
  const paths = [path.resolve(rootPath)]
  for (const pattern of root.workspaces?.packages ?? []) {
    const base = pattern.replace(/\/\*$/, "")
    paths.push(
      ...(yield* fileSystem.glob(`${base}/*/package.json`, { root: rootDirectory })).map((manifestPath) =>
        path.resolve(rootDirectory, manifestPath),
      ),
    )
  }
  return yield* Effect.all(
    paths.toSorted().map((manifestPath) =>
      Effect.gen(function* () {
        const manifest = (yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(
          yield* fileSystem.readFileString(manifestPath),
        )) as PackageManifest
        return { path: path.relative(rootDirectory, manifestPath), manifest }
      }),
    ),
    { concurrency: "unbounded" },
  )
})

export const scanSourcePolicies = Effect.fn("RepositoryPolicy.scanSourcePolicies")(function* (root = ".") {
  const fileSystem = yield* FileSystem
  const path = yield* Path
  const paths = yield* fileSystem.glob("{apps,packages,scripts,test,tooling}/**/*.{ts,tsx,mts,cts}", {
    root,
    exclude: ["**/node_modules/**", "**/dist/**"],
  })
  const diagnostics = yield* Effect.all(
    paths.toSorted().map((absolutePath) =>
      Effect.gen(function* () {
        const filePath = path.isAbsolute(absolutePath) ? path.relative(root, absolutePath) : absolutePath
        const text = yield* fileSystem.readFileString(
          path.isAbsolute(absolutePath) ? absolutePath : path.join(root, absolutePath),
        )
        const basename = invalidBasename(filePath)
        return [...(basename === undefined ? [] : [basename]), ...sourceMetrics(filePath, text)]
      }),
    ),
    { concurrency: "unbounded" },
  )
  return diagnostics.flat()
})
