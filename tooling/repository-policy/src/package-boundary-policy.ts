import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

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
const allDependencies = (manifest: PackageManifest) => ({
  ...manifest.dependencies,
  ...manifest.devDependencies,
  ...manifest.optionalDependencies,
  ...manifest.peerDependencies,
})
const isProvider = (name: string) => languageModelProviderPackages.has(name) || name.startsWith("@ai-sdk/")
const isForbiddenLocalLink = (version: string) =>
  forbiddenProtocols.some((protocol) => version.startsWith(protocol)) && !version.startsWith(autoresearchLinkPrefix)

export const checkDependencyManifests = (manifests: ReadonlyArray<NamedManifest>): string[] =>
  manifests.flatMap(({ path, manifest }) =>
    Object.entries(allDependencies(manifest)).flatMap(([name, version]) => {
      if (isForbiddenLocalLink(version)) return [`${path}: ${name} uses ${version}`]
      if (externalFrameworks.has(name) && version.startsWith("workspace:"))
        return [`${path}: ${name} uses external workspace linking`]
      if (manifest.name === "@rika/tools" && isProvider(name))
        return [`${path}: @rika/tools cannot depend on language-model provider ${name}`]
      return []
    }),
  )

const diagnostic = (
  path: string,
  rule: string,
  message: string,
  remediation: string,
  severity: PolicySeverity = "error",
): PolicyDiagnostic => ({ path, rule, severity, message, remediation })

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

export const checkExportMaps = (manifests: ReadonlyArray<NamedManifest>): PolicyDiagnostic[] =>
  manifests.flatMap(({ path, manifest }) => {
    if (!manifest.name || !manifest.exports) return []
    return Object.entries(manifest.exports).flatMap(([key, target]) => {
      if (key === "." || typeof target !== "string") return []
      if (target.includes("dist/") || target.includes("/src/") === false)
        return [
          diagnostic(
            path,
            "source-exports",
            `export ${key} does not target a source file`,
            "Point the exact export subpath at a source module",
          ),
        ]
      return []
    })
  })

export const checkScriptBoundaries = (manifests: ReadonlyArray<NamedManifest>): PolicyDiagnostic[] =>
  manifests.flatMap(({ path, manifest }) => {
    const scripts = manifest.scripts ?? {}
    return Object.entries(scripts).flatMap(([name, command]) => {
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
    })
  })

export const checkOutputPaths = (manifests: ReadonlyArray<NamedManifest>): PolicyDiagnostic[] =>
  manifests.flatMap(({ path, manifest }) => {
    const commandText = Object.values(manifest.scripts ?? {}).join(" ")
    if (commandText.includes("--outdir dist") || commandText.includes("/dist/")) return []
    if (manifest.name?.startsWith("@rika/") && manifest.rika?.kind !== "tooling")
      return [
        diagnostic(
          path,
          "build-output",
          "build-bearing workspace has no explicit dist output",
          "Build executable output under dist or make the workspace typecheck-only",
        ),
      ]
    return []
  })

export const checkSourceMetrics = (input: {
  readonly path: string
  readonly lines: number
  readonly exports: number
  readonly dependencies: number
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
        "warning",
      ),
    )
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
}): PolicyDiagnostic[] => {
  if (input.testPaths.length > 0 || input.exception !== undefined) return []
  return [
    diagnostic(
      input.sourcePath,
      "test-topology",
      "source module has no same-stem or named broader test",
      "Add a colocated test or a named ownership exception",
      "warning",
    ),
  ]
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
]

export const readWorkspaceManifests = async (rootPath = "package.json"): Promise<NamedManifest[]> => {
  const root = JSON.parse(await readFile(rootPath, "utf8")) as PackageManifest & {
    workspaces?: { packages?: string[] }
  }
  const paths = [rootPath]
  await Promise.all(
    (root.workspaces?.packages ?? []).map(async (pattern) => {
      const base = pattern.replace(/\/\*$/, "")
      const entries = await readdir(base, { withFileTypes: true })
      for (const entry of entries) if (entry.isDirectory()) paths.push(join(base, entry.name, "package.json"))
    }),
  )
  return Promise.all(
    paths
      .toSorted()
      .map(async (path) => ({ path, manifest: JSON.parse(await readFile(path, "utf8")) as PackageManifest })),
  )
}
