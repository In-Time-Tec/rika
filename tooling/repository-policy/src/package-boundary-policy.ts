import { Effect, Schema } from "effect"
import { FileSystem } from "effect/FileSystem"
import { Path } from "effect/Path"
import { parse } from "@typescript-eslint/parser"

type PackageManifest = {
  readonly name?: string
  readonly dependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
  readonly optionalDependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly scripts?: Record<string, string>
  readonly exports?: Record<string, string | Record<string, string>>
  readonly rika?: { readonly kind?: string; readonly domain?: string }
}
type NamedManifest = { readonly path: string; readonly manifest: PackageManifest }
type PolicySeverity = "error" | "warning"
export type PolicyDiagnostic = {
  readonly path: string
  readonly rule: string
  readonly severity: PolicySeverity
  readonly message: string
  readonly remediation: string
}
type TestOwnershipException = {
  readonly sourcePath: string
  readonly testPath: string
  readonly relationship: "direct" | "public-api" | "integration" | "process"
  readonly reason: string
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
const packageOwner = (filePath: string) => {
  if (filePath.startsWith("apps/rika/")) return "@rika/cli"
  const match = /^packages\/([^/]+)\//.exec(filePath)
  return match?.[1] === undefined ? undefined : `@rika/${match[1]}`
}
const sourcePackageEdges: Readonly<Record<string, ReadonlySet<string>>> = allowedPackageEdges
const extensionFrameworks = new Set(["@batonfx/core", "@batonfx/mcp", "@batonfx/skills"])
const isReleasedFrameworkImport = (owner: string | undefined, specifier: string) => {
  if (owner === "@rika/relay-execution")
    return (
      (specifier.startsWith("@batonfx/") || specifier.startsWith("@relayfx/")) &&
      (!specifier.startsWith("@relayfx/") || specifier === "@relayfx/sdk" || specifier === "@relayfx/sdk/sqlite")
    )
  return owner === "@rika/extensions" && extensionFrameworks.has(specifier)
}
const sourceImportDiagnostics = (filePath: string, text: string): PolicyDiagnostic[] => {
  const owner = packageOwner(filePath)
  if (owner === undefined) return []
  const diagnostics: PolicyDiagnostic[] = []
  const importPattern =
    /(?:import\s*(?:type\s*)?(?:[^"']+from\s*)?|export\s+(?:[^"']+from\s*)?|import\s*\()(["'])([^"']+)\1/g
  for (const match of text.matchAll(importPattern)) {
    const specifier = match[2]
    if (specifier === undefined) continue
    const offset = match.index ?? 0
    const line = text.slice(0, offset).split("\n").length
    const rikaTarget = specifier.match(/^(@rika\/[^/]+)/)?.[1]
    if (
      filePath.includes("/src/") &&
      rikaTarget !== undefined &&
      rikaTarget !== owner &&
      owner !== "@rika/cli" &&
      sourcePackageEdges[owner]?.has(rikaTarget) !== true
    )
      diagnostics.push(
        diagnostic(
          `${filePath}:${line}`,
          "source-package-edge",
          `${owner} imports ${specifier}, which is outside the exact package allowlist`,
          "Move the contract inward and import the owning package's exact public subpath",
        ),
      )
    if (specifier.startsWith("@batonfx/") || specifier.startsWith("@relayfx/") || isProvider(specifier)) {
      if (!isReleasedFrameworkImport(owner, specifier))
        diagnostics.push(
          diagnostic(
            `${filePath}:${line}`,
            "forbidden-external-import",
            `${owner} imports forbidden framework or provider package ${specifier}`,
            owner === "@rika/cli"
              ? "Move Relay, Baton, and provider construction behind @rika/relay-execution"
              : "Keep framework and provider imports inside the owning adapter boundary",
          ),
        )
    }
  }
  return diagnostics
}
const isForbiddenLocalLink = (version: string) =>
  forbiddenProtocols.some((protocol) => version.startsWith(protocol)) && !version.startsWith(autoresearchLinkPrefix)
const diagnostic = (
  path: string,
  rule: string,
  message: string,
  remediation: string,
  severity: PolicySeverity = "error",
): PolicyDiagnostic => ({ path, rule, severity, message, remediation })

const checkDependencyManifests = (manifests: ReadonlyArray<NamedManifest>): string[] =>
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

const checkPackageMetadata = (manifests: ReadonlyArray<NamedManifest>): PolicyDiagnostic[] =>
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
const checkExportMaps = (manifests: ReadonlyArray<NamedManifest>): PolicyDiagnostic[] =>
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

const checkScriptBoundaries = (manifests: ReadonlyArray<NamedManifest>): PolicyDiagnostic[] =>
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

const checkOutputPaths = (_manifests: ReadonlyArray<NamedManifest>): PolicyDiagnostic[] => []

const checkSourceMetrics = (input: {
  readonly path: string
  readonly lines: number
  readonly exports: number
  readonly dependencies: number
  readonly functions?: ReadonlyArray<{ readonly name: string; readonly lines: number }>
}): PolicyDiagnostic[] => {
  const diagnostics: PolicyDiagnostic[] = []
  if (input.lines > 800)
    diagnostics.push(
      diagnostic(input.path, "file-size", `file has ${input.lines} lines`, "Split the file at a semantic boundary"),
    )
  else if (input.lines > 500)
    diagnostics.push(
      diagnostic(
        input.path,
        "file-size",
        `file has ${input.lines} lines`,
        "Keep changed files under 500 lines",
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

const checkDirectoryMetrics = (input: { readonly path: string; readonly sourceFiles: number }): PolicyDiagnostic[] => {
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
const checkTestTopology = (input: {
  readonly sourcePath: string
  readonly testPaths: ReadonlyArray<string>
  readonly exception?: string
}): PolicyDiagnostic[] => {
  const sourceMatch = /^(.*)\/src\/(.*)\.(tsx?)$/.exec(input.sourcePath)
  const sameStem =
    sourceMatch !== null &&
    input.testPaths.some(
      (testPath) =>
        testPath === `${sourceMatch[1]}/test/${sourceMatch[2]}.test.${sourceMatch[3]}` ||
        testPath === input.sourcePath.replace(/\.(tsx?)$/, ".test.$1"),
    )
  return sameStem || input.exception !== undefined
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
}

const checkPackageEdges = (manifests: ReadonlyArray<NamedManifest>): PolicyDiagnostic[] => {
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

const checkManifests = (manifests: ReadonlyArray<NamedManifest>): PolicyDiagnostic[] => [
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

const migrationBasenamePattern = /^product-migration-(\d{3})-([a-z0-9]+(?:-[a-z0-9]+)*)\.ts$/
const migrationBasename = (filePath: string) => {
  const basename = filePath.split("/").pop() ?? ""
  if (!/^product-migration-\d/.test(basename) || basename.endsWith(".test.ts")) return undefined
  if (!migrationBasenamePattern.test(basename))
    return diagnostic(
      filePath,
      "migration-basename",
      "product migration basename must be product-migration-NNN-descriptive-kebab.ts",
      "Use a three-digit unique migration ID followed by a nonempty descriptive kebab-case suffix",
    )
  return undefined
}

const frameworkConfigBasenames = new Set(["vitest.config.ts"])
const checkSourceBasename = (filePath: string) => {
  const basename = filePath.split("/").pop() ?? ""
  if (frameworkConfigBasenames.has(basename)) return undefined
  const migration = migrationBasename(filePath)
  if (migration !== undefined || /^product-migration-\d/.test(basename)) return migration
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

const checkMigrationIdentity = (filePaths: ReadonlyArray<string>): PolicyDiagnostic[] => {
  const entries = filePaths.flatMap((filePath) => {
    const basename = filePath.split("/").pop() ?? ""
    const match = migrationBasenamePattern.exec(basename)
    return match?.[1] === undefined ? [] : [{ filePath, id: match[1] }]
  })
  const ids = new Map<string, string[]>()
  for (const entry of entries) ids.set(entry.id, [...(ids.get(entry.id) ?? []), entry.filePath])
  return [...ids.entries()]
    .filter(([, paths]) => paths.length > 1)
    .flatMap(([id, paths]) =>
      paths.map((filePath) =>
        diagnostic(
          filePath,
          "migration-identity",
          `product migration ID ${id} is used by more than one source file`,
          "Assign every product migration a unique three-digit ID",
        ),
      ),
    )
}

const validateOwnershipExceptions = (value: unknown): TestOwnershipException[] => {
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

const readWorkspaceManifests = Effect.fn("RepositoryPolicy.readWorkspaceManifests")(function* (
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

const checkWorkspaceTestTopology = Effect.fn("RepositoryPolicy.checkWorkspaceTestTopology")(function* (
  root = ".",
  exceptions: ReadonlyArray<TestOwnershipException> = [],
) {
  const fileSystem = yield* FileSystem
  const path = yield* Path
  const sources = yield* fileSystem.glob("{apps,packages}/**/src/**/*.ts", {
    root,
    exclude: ["**/node_modules/**", "**/dist/**", "**/.turbo/**"],
  })
  const tests = yield* fileSystem.glob("{apps,packages}/**/test/**/*.ts", {
    root,
    exclude: ["**/node_modules/**", "**/dist/**", "**/.turbo/**"],
  })
  const relative = (value: string) =>
    (path.isAbsolute(value) ? path.relative(root, value) : value).replaceAll("\\", "/")
  const sourcePaths = new Set(sources.map(relative))
  const testPaths = new Set(tests.map(relative))
  const diagnostics: PolicyDiagnostic[] = []
  const exceptionSources = new Set<string>()
  for (const exception of exceptions) {
    if (exceptionSources.has(exception.sourcePath))
      diagnostics.push(
        diagnostic(
          exception.sourcePath,
          "test-topology-exception",
          "source module has more than one ownership exception",
          "Keep one exact exception for each source module",
        ),
      )
    exceptionSources.add(exception.sourcePath)
    if (!sourcePaths.has(exception.sourcePath))
      diagnostics.push(
        diagnostic(
          exception.sourcePath,
          "test-topology-exception",
          "ownership exception names a missing source module",
          "Remove the stale exception or point it at an existing source path",
        ),
      )
    if (!testPaths.has(exception.testPath))
      diagnostics.push(
        diagnostic(
          exception.testPath,
          "test-topology-exception",
          "ownership exception names a missing test module",
          "Remove the stale exception or point it at an existing test path",
        ),
      )
    if (sourcePaths.has(exception.sourcePath) && testPaths.has(exception.testPath)) {
      const testText = yield* fileSystem.readFileString(path.join(root, exception.testPath))
      const sourceStem =
        exception.sourcePath
          .split("/")
          .at(-1)
          ?.replace(/\.tsx?$/, "") ?? ""
      const sourceImport = exception.sourcePath.replace(/\.(tsx?)$/, "")
      if (!testText.includes(sourceStem) && !testText.includes(sourceImport))
        diagnostics.push(
          diagnostic(
            exception.testPath,
            "test-topology-exception",
            `ownership exception test does not reach ${exception.sourcePath}`,
            "Use a broader test that imports or exercises the named source module",
          ),
        )
    }
  }
  for (const sourcePath of sourcePaths) {
    const packageRoot = sourcePath.split("/src/")[0]
    const ownedTests = [...testPaths].filter((testPath) => testPath.startsWith(`${packageRoot}/test/`))
    const exception = exceptions.find((item) => item.sourcePath === sourcePath)?.testPath
    diagnostics.push(
      ...checkTestTopology({ sourcePath, testPaths: ownedTests, ...(exception === undefined ? {} : { exception }) }),
    )
  }
  return diagnostics
})

const scanSourcePolicies = Effect.fn("RepositoryPolicy.scanSourcePolicies")(function* (root = ".") {
  const fileSystem = yield* FileSystem
  const path = yield* Path
  const paths = (yield* fileSystem.glob("{apps,packages,scripts,test,tooling}/**/*.{ts,tsx,mts,cts}", {
    root,
    exclude: ["**/node_modules/**", "**/dist/**"],
  })).filter((candidate) => {
    const segments = candidate.split(/[\\/]+/)
    return !segments.includes("node_modules") && !segments.includes("dist")
  })
  const sortedPaths = paths.toSorted()
  const diagnostics = yield* Effect.all(
    sortedPaths.map((absolutePath) =>
      Effect.gen(function* () {
        const filePath = path.isAbsolute(absolutePath) ? path.relative(root, absolutePath) : absolutePath
        const text = yield* fileSystem.readFileString(
          path.isAbsolute(absolutePath) ? absolutePath : path.join(root, absolutePath),
        )
        const basename = checkSourceBasename(filePath)
        return [
          ...(basename === undefined ? [] : [basename]),
          ...sourceMetrics(filePath, text),
          ...sourceImportDiagnostics(filePath, text),
        ]
      }),
    ),
    { concurrency: "unbounded" },
  )
  return [
    ...diagnostics.flat(),
    ...checkMigrationIdentity(sortedPaths.map((absolutePath) => path.relative(root, absolutePath))),
  ]
})

export const repositoryPolicy = {
  checkDependencyManifests,
  checkPackageMetadata,
  checkExportMaps,
  checkScriptBoundaries,
  checkOutputPaths,
  checkSourceMetrics,
  checkDirectoryMetrics,
  checkTestTopology,
  checkPackageEdges,
  checkManifests,
  checkMigrationIdentity,
  validateOwnershipExceptions,
  checkSourceBasename,
  readWorkspaceManifests,
  checkWorkspaceTestTopology,
  scanSourcePolicies,
}
