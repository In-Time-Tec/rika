import { cruise, type IDependency, type ICruiseResult } from "dependency-cruiser"
import { format as formatJson } from "prettier"
import { Effect, Schema } from "effect"
import { FileSystem } from "effect/FileSystem"
import { Path } from "effect/Path"

export type GraphKind = "all" | "production" | "test" | "package"
type TestKind = "unit-test" | "integration-test" | "contract-test" | "tui-test" | "process-test" | "fixture"
type GraphNode = {
  readonly id: string
  readonly path?: string
  readonly workspace?: string
  readonly package?: string
  readonly kind: "source" | "asset" | "external" | "package"
  readonly production: boolean
  readonly publicExports: ReadonlyArray<string>
  readonly testKind?: TestKind
}
type GraphRelationship = "runtime" | "type" | "test" | "asset"
type GraphEdge = {
  readonly from: string
  readonly to: string
  readonly relationship: GraphRelationship
  readonly specifier: string
  readonly kind: "import" | "dynamic-import" | "package"
  readonly production: boolean
  readonly dependencySection?: "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies"
}
export type GraphArtifact = {
  readonly schemaVersion: 1
  readonly graphKind: GraphKind
  readonly nodes: GraphNode[]
  readonly edges: GraphEdge[]
  readonly violations: string[]
}

type Manifest = {
  name?: string
  exports?: Record<string, string | Record<string, string>>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}
type Workspace = { name: string; root: string; manifest: Manifest }
type ParserDependency = IDependency & { readonly typeOnly?: boolean }
type ParserModule = { readonly source: string; readonly dependencies?: ReadonlyArray<ParserDependency> }

class GraphError extends Schema.TaggedErrorClass<GraphError>()("RepositoryGraphError", {
  message: Schema.String,
}) {}

type GraphInput = {
  readonly root: string
  readonly files: ReadonlyArray<string>
  readonly workspaces: ReadonlyArray<Workspace>
  readonly parser: ICruiseResult
}

const sourceRoots = ["apps", "packages", "scripts", "test", "tooling"]
const pathId = (path: string) => path.replaceAll("\\", "/")
const testKindOf = (path: string): TestKind | undefined => {
  if (path.includes("/fixtures/") || path.includes("/fixture/")) return "fixture"
  if (path.includes("/test/contract/") || path.includes("/contract/")) return "contract-test"
  if (path.endsWith(".tui.test.ts")) return "tui-test"
  if (path.endsWith(".proc.test.ts")) return "process-test"
  if (path.endsWith(".integration.test.ts")) return "integration-test"
  if (path.endsWith(".test.ts")) return "unit-test"
  return undefined
}
const packageNameOf = (path: string, workspaces: ReadonlyArray<Workspace>) =>
  workspaces.find((workspace) => path === workspace.root || path.startsWith(`${workspace.root}/`))?.name
const packageNameFromSpecifier = (specifier: string) =>
  specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : (specifier.split("/")[0] ?? specifier)
const packageSubpath = (specifier: string, packageName: string) =>
  specifier.slice(packageName.length).replace(/^\//, "")
const parserInput = (files: ReadonlyArray<string>) => files.filter((file) => !file.endsWith(".prompt.txt"))
const exportTarget = (target: string | Record<string, string>): string | undefined =>
  typeof target === "string" ? target : (target.import ?? target.default ?? target.require ?? Object.values(target)[0])

const parseJson = Effect.fn("RepositoryGraph.parseJson")(function* (filePath: string) {
  const fileSystem = yield* FileSystem
  return (yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(
    yield* fileSystem.readFileString(filePath),
  )) as Manifest & { workspaces?: { packages?: string[] } }
})

const discoverFiles = Effect.fn("RepositoryGraph.discoverFiles")(function* (root: string) {
  const fileSystem = yield* FileSystem
  const path = yield* Path
  const paths = yield* Effect.all(
    sourceRoots.flatMap((entry) => [
      fileSystem.glob(`${entry}/**/*.{ts,tsx,prompt.txt}`, { root, exclude: ["**/node_modules/**"] }),
      fileSystem.glob(`${entry}/**/fixtures/**/*.json`, { root, exclude: ["**/node_modules/**"] }),
    ]),
    { concurrency: "unbounded" },
  )
  return paths
    .flat()
    .map(pathId)
    .map((entry) => path.relative(root, path.resolve(root, entry)))
    .toSorted()
})

const discoverWorkspaces = Effect.fn("RepositoryGraph.discoverWorkspaces")(function* (root: string) {
  const fileSystem = yield* FileSystem
  const path = yield* Path
  const rootManifest = yield* parseJson(path.join(root, "package.json"))
  const patterns = rootManifest.workspaces?.packages ?? []
  const manifestPaths = [path.join(root, "package.json")]
  for (const pattern of patterns) {
    const base = pattern.replace(/\/\*$/, "")
    manifestPaths.push(...(yield* fileSystem.glob(`${base}/*/package.json`, { root })))
  }
  const manifests = yield* Effect.all(
    manifestPaths.toSorted().map((manifestPath) =>
      Effect.gen(function* () {
        const manifest = yield* parseJson(path.resolve(root, manifestPath))
        const manifestRoot = path.dirname(path.resolve(root, manifestPath))
        return { name: manifest.name ?? manifestRoot, root: manifestRoot, manifest }
      }),
    ),
    { concurrency: "unbounded" },
  )
  return manifests.filter((workspace) => workspace.root !== root)
})

const runParser = Effect.fn("RepositoryGraph.runParser")(function* (root: string, files: ReadonlyArray<string>) {
  const path = yield* Path
  const result = yield* Effect.tryPromise({
    try: () =>
      cruise(
        parserInput(files),
        { baseDir: root, doNotFollow: { path: "node_modules" }, tsPreCompilationDeps: true },
        undefined,
        {
          tsConfig: {
            fileName: path.relative(".", path.join(root, "tsconfig.json")),
            module: "ESNext",
            moduleResolution: "Bundler",
          },
        },
      ),
    catch: (error) => GraphError.make({ message: `dependency-cruiser failed: ${String(error)}` }),
  })
  if (typeof result.output === "string") return yield* GraphError.make({ message: result.output })
  return result.output
})

const resolveRelativeImport = (source: string, specifier: string, files: ReadonlySet<string>, path: Path) => {
  const base = path.normalize(path.join(path.dirname(source), specifier))
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.json`,
    `${base}.prompt.txt`,
    `${base}/index.ts`,
  ].find((candidate) => files.has(candidate))
}

const resolveWorkspaceExport = (
  specifier: string,
  workspace: Workspace,
  files: ReadonlySet<string>,
  root: string,
  path: Path,
): { readonly target: string; readonly exportName: string } | undefined => {
  const subpath = packageSubpath(specifier, workspace.name)
  const key = subpath === "" ? "." : `./${subpath}`
  const targetValue = workspace.manifest.exports?.[key]
  if (targetValue === undefined) return undefined
  const target = exportTarget(targetValue)
  if (target === undefined) return undefined
  const candidate = pathId(path.relative(root, path.resolve(workspace.root, target)))
  return files.has(candidate) ? { target: candidate, exportName: key } : undefined
}

const publicExportsFor = (workspace: Workspace | undefined, filePath: string, root: string, path: Path) => {
  if (workspace?.manifest.exports === undefined) return []
  return Object.entries(workspace.manifest.exports)
    .filter(([, value]) => {
      const target = exportTarget(value)
      return target !== undefined && pathId(path.relative(root, path.resolve(workspace.root, target))) === filePath
    })
    .map(([key]) => key)
    .toSorted()
}

const parserPath = (value: string, root: string, path: Path) =>
  path.isAbsolute(value) ? pathId(path.relative(root, value)) : pathId(path.normalize(value))

const packageSections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const
const packageEdges = (
  workspace: Workspace,
  workspaceByName: ReadonlyMap<string, Workspace>,
): ReadonlyArray<GraphEdge> =>
  packageSections.flatMap((section) =>
    Object.keys(workspace.manifest[section] ?? {})
      .filter((name) => workspaceByName.has(name))
      .map((name) => ({
        from: `package:${workspace.name}`,
        to: `package:${name}`,
        specifier: name,
        kind: "package" as const,
        relationship: section === "devDependencies" ? ("test" as const) : ("runtime" as const),
        production: section !== "devDependencies",
        dependencySection: section,
      })),
  )

const makeInput = Effect.fn("RepositoryGraph.makeInput")(function* (root: string) {
  const files = yield* discoverFiles(root)
  const [workspaces, parser] = yield* Effect.all([discoverWorkspaces(root), runParser(root, files)])
  return { root, files, workspaces, parser } satisfies GraphInput
})

const buildCompleteGraph = (input: GraphInput, path: Path): GraphArtifact => {
  const fileSet = new Set(input.files)
  const workspaceByName = new Map(input.workspaces.map((workspace) => [workspace.name, workspace]))
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const violations = new Set<string>()
  const nodeFor = (id: string, external = false): GraphNode => {
    const workspace = packageNameOf(path.resolve(input.root, id), input.workspaces)
    const testKind = testKindOf(id)
    let nodeKind: GraphNode["kind"] = "source"
    if (external) nodeKind = "external"
    else if (id.endsWith(".prompt.txt") || id.endsWith(".json")) nodeKind = "asset"
    return {
      id,
      ...(external ? {} : { path: id }),
      workspace: workspace ?? "root",
      ...(workspace === undefined ? {} : { package: workspace }),
      kind: nodeKind,
      production: testKind === undefined,
      publicExports: external ? [] : publicExportsFor(workspaceByName.get(workspace ?? ""), id, input.root, path),
      ...(testKind === undefined ? {} : { testKind }),
    }
  }
  for (const file of input.files) nodes.set(file, nodeFor(file))
  const parserModules = input.parser.modules as ReadonlyArray<ParserModule>
  for (const module of parserModules) {
    const source = parserPath(module.source, input.root, path)
    if (!fileSet.has(source)) continue
    const sourceNode = nodes.get(source)
    const sourceTest = sourceNode?.testKind
    for (const dependency of module.dependencies ?? []) {
      const specifier = dependency.module
      const packageName = packageNameFromSpecifier(specifier)
      const workspace = workspaceByName.get(packageName)
      let target: string | undefined
      let exportName: string | undefined
      if (dependency.couldNotResolve !== true && dependency.resolved !== undefined) {
        const resolved = parserPath(dependency.resolved, input.root, path)
        if (fileSet.has(resolved)) target = resolved
      }
      if (target === undefined && specifier.startsWith("."))
        target = resolveRelativeImport(source, specifier, fileSet, path)
      if (target === undefined && workspace !== undefined) {
        const resolved = resolveWorkspaceExport(specifier, workspace, fileSet, input.root, path)
        target = resolved?.target
        exportName = resolved?.exportName
      }
      if (target === undefined && workspace !== undefined) {
        violations.add(`${source}: unresolved internal import ${specifier}`)
        continue
      }
      if (target === undefined && (specifier.startsWith(".") || specifier.startsWith("/"))) {
        violations.add(`${source}: unresolved internal or asset import ${specifier}`)
        continue
      }
      if (target === undefined) {
        target = `external:${specifier}`
        if (!nodes.has(target)) nodes.set(target, { ...nodeFor(target, true), package: packageName })
      } else if (exportName !== undefined) {
        const current = nodes.get(target)
        if (current !== undefined && !current.publicExports.includes(exportName))
          nodes.set(target, { ...current, publicExports: [...current.publicExports, exportName].toSorted() })
      }
      if (!nodes.has(target)) nodes.set(target, nodeFor(target))
      let relationship: GraphRelationship = "test"
      if (target.endsWith(".prompt.txt") || target.endsWith(".json")) relationship = "asset"
      else if (dependency.typeOnly === true) relationship = "type"
      else if (sourceTest === undefined) relationship = "runtime"
      edges.push({
        from: source,
        to: target,
        specifier,
        kind: dependency.dynamic ? "dynamic-import" : "import",
        relationship,
        production: relationship === "runtime" || relationship === "type" || relationship === "asset",
      })
    }
  }
  for (const workspace of input.workspaces) {
    const id = `package:${workspace.name}`
    nodes.set(id, {
      id,
      package: workspace.name,
      workspace: workspace.name,
      kind: "package",
      production: true,
      publicExports: Object.keys(workspace.manifest.exports ?? {}).toSorted(),
    })
    edges.push(...packageEdges(workspace, workspaceByName))
  }
  const sortedNodes = [...nodes.values()].toSorted((a, b) => a.id.localeCompare(b.id))
  const sortedEdges = edges.toSorted((a, b) =>
    `${a.from}:${a.to}:${a.specifier}:${a.relationship}`.localeCompare(
      `${b.from}:${b.to}:${b.specifier}:${b.relationship}`,
    ),
  )
  return {
    schemaVersion: 1,
    graphKind: "all",
    nodes: sortedNodes,
    edges: sortedEdges,
    violations: [...violations].toSorted(),
  }
}

const projectGraph = (all: GraphArtifact, graphKind: GraphKind): GraphArtifact => {
  if (graphKind === "all") return all
  if (graphKind === "package") {
    const ids = new Set(all.nodes.filter((node) => node.kind === "package").map((node) => node.id))
    return {
      ...all,
      graphKind,
      nodes: all.nodes.filter((node) => ids.has(node.id)),
      edges: all.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
    }
  }
  const nodeIds = new Set(
    graphKind === "production"
      ? all.nodes.filter((node) => node.production).map((node) => node.id)
      : all.nodes.filter((node) => node.testKind !== undefined || node.kind === "external").map((node) => node.id),
  )
  const edges =
    graphKind === "production"
      ? all.edges.filter((edge) => edge.production && nodeIds.has(edge.from) && nodeIds.has(edge.to))
      : all.edges.filter(
          (edge) =>
            (all.nodes.find((node) => node.id === edge.from)?.testKind !== undefined || edge.relationship === "test") &&
            nodeIds.has(edge.from) &&
            nodeIds.has(edge.to),
        )
  for (const edge of edges) {
    nodeIds.add(edge.from)
    nodeIds.add(edge.to)
  }
  return { ...all, graphKind, nodes: all.nodes.filter((node) => nodeIds.has(node.id)), edges }
}

export const classifyTestKind = testKindOf
export const scanImports = (text: string) => {
  const imports: Array<{ readonly specifier: string; readonly kind: "import" | "dynamic-import" }> = []
  for (const match of text.matchAll(/(?:import|export)\s+(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["']/g)) {
    const specifier = match[1]
    if (specifier !== undefined && !imports.some((item) => item.specifier === specifier && item.kind === "import"))
      imports.push({ specifier, kind: "import" })
  }
  for (const match of text.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    const specifier = match[1]
    if (
      specifier !== undefined &&
      !imports.some((item) => item.specifier === specifier && item.kind === "dynamic-import")
    )
      imports.push({ specifier, kind: "dynamic-import" })
  }
  return imports.toSorted((a, b) => `${a.specifier}:${a.kind}`.localeCompare(`${b.specifier}:${b.kind}`))
}

export const buildGraphs = Effect.fn("RepositoryGraph.buildGraphs")(function* (root = ".") {
  const path = yield* Path
  const rootPath = path.resolve(root)
  const input = yield* makeInput(rootPath)
  const all = buildCompleteGraph(input, path)
  return {
    all,
    production: projectGraph(all, "production"),
    test: projectGraph(all, "test"),
    package: projectGraph(all, "package"),
  } satisfies Record<GraphKind, GraphArtifact>
})

const artifactName = (kind: GraphKind) => (kind === "all" ? "dependency-graph" : `${kind}-dependency-graph`)
const artifactPath = (kind: GraphKind, outputDirectory = "docs/generated") =>
  `${outputDirectory}/${artifactName(kind)}.json`
export const graphFilePath = { resolve: artifactPath }

export const writeGraphs = Effect.fn("RepositoryGraph.writeGraphs")(function* (
  root = ".",
  outputDirectory = "docs/generated",
) {
  const fileSystem = yield* FileSystem
  const graphs = yield* buildGraphs(root)
  yield* fileSystem.makeDirectory(outputDirectory, { recursive: true })
  yield* Effect.all(
    (Object.keys(graphs) as GraphKind[]).map((kind) =>
      Effect.tryPromise({
        try: () =>
          formatJson(`${globalThis.JSON.stringify(graphs[kind], null, 2)}\n`, { parser: "json", printWidth: 120 }),
        catch: (error) => GraphError.make({ message: `could not format graph: ${String(error)}` }),
      }).pipe(
        Effect.flatMap((contents) =>
          fileSystem.writeFileString(graphFilePath.resolve(kind, outputDirectory), contents),
        ),
      ),
    ),
    { concurrency: "unbounded" },
  )
  return graphs
})

export const readGraph = Effect.fn("RepositoryGraph.readGraph")(function* (
  kind: GraphKind,
  inputDirectory = "docs/generated",
) {
  const fileSystem = yield* FileSystem
  return (yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(
    yield* fileSystem.readFileString(graphFilePath.resolve(kind, inputDirectory)),
  )) as GraphArtifact
})
