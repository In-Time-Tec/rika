import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, extname } from "node:path"

export type GraphKind = "all" | "production" | "test" | "package"
export type TestKind = "unit" | "integration" | "tui" | "proc" | "native" | "journey" | "fixture"
export type GraphNode = {
  readonly id: string
  readonly path?: string
  readonly package?: string
  readonly kind: "source" | "asset" | "external" | "package"
  readonly testKind?: TestKind
}
export type GraphEdge = {
  readonly from: string
  readonly to: string
  readonly specifier: string
  readonly kind: "import" | "dynamic-import" | "package"
  readonly testKind?: TestKind
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

const sourceRoots = ["apps", "packages", "scripts", "test", "tooling"]
const ignored = /(^|\/)node_modules\//
const pathId = (path: string) => path.replaceAll("\\", "/")
const testKindOf = (path: string): TestKind | undefined => {
  if (path.endsWith(".tui.test.ts")) return "tui"
  if (path.endsWith(".proc.test.ts")) return "proc"
  if (path.endsWith(".native.test.ts")) return "native"
  if (path.endsWith(".journey.test.ts")) return "journey"
  if (path.endsWith(".integration.test.ts")) return "integration"
  if (path.includes("/fixtures/") || path.includes("/fixture/")) return "fixture"
  if (path.endsWith(".test.ts")) return "unit"
  return undefined
}
const packageNameOf = (path: string, workspaces: Workspace[]) =>
  workspaces.find((workspace) => path === workspace.root || path.startsWith(`${workspace.root}/`))?.name
const packageNameFromSpecifier = (specifier: string) =>
  specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : (specifier.split("/")[0] ?? specifier)
const packageSubpath = (specifier: string, packageName: string) =>
  specifier.slice(packageName.length).replace(/^\//, "")

const discoverFiles = async () => {
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name)
        if (entry.isDirectory() && !ignored.test(`${path}/`)) await visit(path)
        else if (entry.isFile() && !ignored.test(path) && (/\.tsx?$/.test(path) || path.endsWith(".prompt.txt")))
          files.push(pathId(path))
      }),
    )
  }
  await Promise.all(sourceRoots.map((root) => visit(root)))
  return files.toSorted()
}
const discoverWorkspaces = async (): Promise<Workspace[]> => {
  const root = JSON.parse(await readFile("package.json", "utf8")) as { workspaces?: { packages?: string[] } }
  const paths: string[] = []
  await Promise.all(
    (root.workspaces?.packages ?? []).map(async (pattern) => {
      const base = pattern.replace(/\/\*$/, "")
      const entries = await readdir(base, { withFileTypes: true })
      for (const entry of entries) if (entry.isDirectory()) paths.push(join(base, entry.name, "package.json"))
    }),
  )
  return Promise.all(
    paths.toSorted().map(async (manifestPath) => {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest
      return { name: manifest.name ?? manifestPath, root: dirname(manifestPath), manifest }
    }),
  )
}

const importsOf = (text: string) => {
  const imports: Array<{ specifier: string; kind: "import" | "dynamic-import" }> = []
  const patterns: Array<[RegExp, "import" | "dynamic-import"]> = [
    [/(?:import|export)\s+(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["']/g, "import"],
    [/import\s*\(\s*["']([^"']+)["']\s*\)/g, "dynamic-import"],
    [/require\s*\(\s*["']([^"']+)["']\s*\)/g, "import"],
  ]
  for (const [pattern, kind] of patterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier && !imports.some((item) => item.specifier === specifier && item.kind === kind))
        imports.push({ specifier, kind })
    }
  }
  return imports.toSorted((a, b) => `${a.specifier}:${a.kind}`.localeCompare(`${b.specifier}:${b.kind}`))
}

const resolveRelative = (source: string, specifier: string, files: Set<string>) => {
  const base = pathId(resolve(dirname(source), specifier))
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.json`,
    `${base}.prompt.txt`,
    `${base}/index.ts`,
  ]
  return candidates
    .map((candidate) => pathId(relative(process.cwd(), candidate)))
    .find((candidate) => files.has(candidate))
}
const resolveWorkspace = (specifier: string, workspace: Workspace, files: Set<string>) => {
  const subpath = packageSubpath(specifier, workspace.name)
  const key = subpath === "" ? "." : `./${subpath}`
  const target = workspace.manifest.exports?.[key]
  if (typeof target !== "string") return undefined
  const candidate = pathId(relative(process.cwd(), resolve(workspace.root, target)))
  return files.has(candidate) ? candidate : undefined
}

export const classifyTestKind = testKindOf
export const scanImports = importsOf

export const buildGraphs = async (): Promise<Record<GraphKind, GraphArtifact>> => {
  const files = await discoverFiles()
  const fileSet = new Set(files)
  const workspaces = await discoverWorkspaces()
  const workspaceByName = new Map(workspaces.map((workspace) => [workspace.name, workspace]))
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const violations: string[] = []
  for (const path of files) {
    const testKind = testKindOf(path)
    const packageName = packageNameOf(path, workspaces)
    nodes.set(path, {
      id: path,
      path,
      kind: path.endsWith(".prompt.txt") ? "asset" : "source",
      ...(packageName ? { package: packageName } : {}),
      ...(testKind ? { testKind } : {}),
    })
  }
  await Promise.all(
    files
      .filter((path) => !path.endsWith(".prompt.txt"))
      .map(async (source) => {
        const sourceTestKind = testKindOf(source)
        const text = await readFile(source, "utf8")
        for (const { specifier, kind } of importsOf(text)) {
          const packageName = packageNameFromSpecifier(specifier)
          const workspace = workspaceByName.get(packageName)
          let target: string | undefined
          if (specifier.startsWith(".")) target = resolveRelative(source, specifier, fileSet)
          else if (workspace) target = resolveWorkspace(specifier, workspace, fileSet)
          else {
            target = `external:${packageName}`
            nodes.set(target, { id: target, package: packageName, kind: "external" })
          }
          if (!target) {
            violations.push(`${source}: unresolved internal import ${specifier}`)
            continue
          }
          if (!nodes.has(target)) {
            const targetPackage = packageNameOf(target, workspaces)
            const targetTestKind = testKindOf(target)
            nodes.set(target, {
              id: target,
              path: target,
              kind: target.endsWith(".prompt.txt") ? "asset" : "source",
              ...(targetPackage ? { package: targetPackage } : {}),
              ...(targetTestKind ? { testKind: targetTestKind } : {}),
            })
          }
          edges.push({
            from: source,
            to: target,
            specifier,
            kind,
            ...(sourceTestKind ? { testKind: sourceTestKind } : {}),
          })
        }
      }),
  )
  for (const workspace of workspaces) {
    const dependencies = {
      ...workspace.manifest.dependencies,
      ...workspace.manifest.devDependencies,
      ...workspace.manifest.optionalDependencies,
      ...workspace.manifest.peerDependencies,
    }
    for (const dependency of Object.keys(dependencies).filter((name) => workspaceByName.has(name)))
      edges.push({
        from: `package:${workspace.name}`,
        to: `package:${dependency}`,
        specifier: dependency,
        kind: "package",
      })
    nodes.set(`package:${workspace.name}`, {
      id: `package:${workspace.name}`,
      package: workspace.name,
      kind: "package",
    })
  }
  const sortedNodes = [...nodes.values()].toSorted((a, b) => a.id.localeCompare(b.id))
  const sortedEdges = edges.toSorted((a, b) =>
    `${a.from}:${a.to}:${a.specifier}`.localeCompare(`${b.from}:${b.to}:${b.specifier}`),
  )
  const all: GraphArtifact = {
    schemaVersion: 1,
    graphKind: "all",
    nodes: sortedNodes,
    edges: sortedEdges,
    violations: [...new Set(violations)].toSorted(),
  }
  const productionNodes = new Set(sortedNodes.filter((node) => !node.testKind).map((node) => node.id))
  const testNodes = new Set(sortedNodes.filter((node) => node.testKind).map((node) => node.id))
  const production: GraphArtifact = {
    schemaVersion: 1,
    graphKind: "production",
    nodes: sortedNodes.filter((node) => productionNodes.has(node.id)),
    edges: sortedEdges.filter((edge) => productionNodes.has(edge.from) && productionNodes.has(edge.to)),
    violations: all.violations,
  }
  const test: GraphArtifact = {
    schemaVersion: 1,
    graphKind: "test",
    nodes: sortedNodes.filter((node) => testNodes.has(node.id) || node.kind === "external"),
    edges: sortedEdges.filter((edge) => testNodes.has(edge.from)),
    violations: all.violations,
  }
  const packageNodes = sortedNodes.filter((node) => node.kind === "package")
  const packageEdges = sortedEdges.filter((edge) => edge.kind === "package")
  const packages: GraphArtifact = {
    schemaVersion: 1,
    graphKind: "package",
    nodes: packageNodes,
    edges: packageEdges,
    violations: [],
  }
  return { all, production, test, package: packages }
}

const artifactPath = (kind: GraphKind, outputDirectory = "docs/generated") =>
  resolve(outputDirectory, `${kind === "all" ? "dependency-graph" : `${kind}-dependency-graph`}.json`)
export const writeGraphs = async (outputDirectory = "docs/generated") => {
  const graphs = await buildGraphs()
  await mkdir(outputDirectory, { recursive: true })
  await Promise.all(
    (["all", "production", "test", "package"] as const).map((kind) =>
      writeFile(artifactPath(kind, outputDirectory), `${JSON.stringify(graphs[kind], null, 2)}\n`),
    ),
  )
  return graphs
}
export const readGraph = async (kind: GraphKind, inputDirectory = "docs/generated") =>
  JSON.parse(await readFile(artifactPath(kind, inputDirectory), "utf8")) as GraphArtifact
export const graphFilePath = artifactPath
export const sourceFileExtension = (path: string) => extname(path)
