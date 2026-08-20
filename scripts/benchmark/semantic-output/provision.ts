import { HostFiles } from "./host-files"
import { tenetkitReleaseInventoryError, tenetkitReleasePackages } from "../../release/local-tenetkit-smoke"
import { tenetkitPackages } from "../../release/local-tenetkit-package-verification"

interface Evidence {
  readonly schemaVersion: number
  readonly sourceCommit?: string
  readonly packages: ReadonlyArray<{
    readonly name: string
    readonly version: string
    readonly filename: string
    readonly sha256: string
  }>
}

const run = (
  command: ReadonlyArray<string>,
  cwd: string,
  environment: Readonly<Record<string, string>> = {},
): string => {
  const environmentArguments = Object.entries(environment).map(([key, value]) => `${key}=${value}`)
  const executable = environmentArguments.length === 0 ? command : ["env", ...environmentArguments, ...command]
  const result = Bun.spawnSync([...executable], { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0)
    throw new Error(
      `${command.join(" ")} failed (${result.exitCode})\n${result.stderr.toString()}\n${result.stdout.toString()}`,
    )
  return result.stdout.toString()
}

const fileSha256 = (path: string): string => new Bun.CryptoHasher("sha256").update(HostFiles.bytes(path)).digest("hex")

const releaseInventory = (directory: string): Evidence => {
  const evidence = JSON.parse(HostFiles.read(HostFiles.join(directory, "release-evidence.json"))) as Evidence
  const checksumLines = HostFiles.read(HostFiles.join(directory, "SHA256SUMS")).trim().split("\n")
  const checksums = new Map(
    checksumLines.map((line) => {
      const match = /^([a-f0-9]{64})  ([^/]+)$/u.exec(line)
      if (match === null) throw new Error(`invalid SHA256SUMS line: ${line}`)
      return [match[2]!, match[1]!] as const
    }),
  )
  const inventoryError = tenetkitReleaseInventoryError(evidence, "0.20.2", [...checksums.keys()])
  if (inventoryError !== undefined) throw new Error(inventoryError)
  for (const [filename, digest] of checksums) {
    if (fileSha256(HostFiles.join(directory, filename)) !== digest)
      throw new Error(`candidate release checksum mismatch: ${filename}`)
  }
  for (const item of evidence.packages) {
    if (checksums.get(item.filename) !== item.sha256)
      throw new Error(`candidate evidence checksum mismatch: ${item.filename}`)
    const manifest = JSON.parse(
      run(["tar", "-xOzf", HostFiles.join(directory, item.filename), "package/package.json"], directory),
    ) as {
      readonly name?: string
      readonly version?: string
    }
    if (manifest.name !== item.name || manifest.version !== item.version)
      throw new Error(`candidate tarball identity mismatch: ${item.filename}`)
  }
  return evidence
}

const benchmarkFiles = [
  "semantic-output-worker.ts",
  "semantic-output/worker-cli.ts",
  "semantic-output/contract.ts",
  "semantic-output/workload.ts",
  "semantic-output/process-tree.ts",
  "semantic-output/isolation.ts",
  "semantic-output/database-evidence.ts",
  "semantic-output/host-files.ts",
] as const

const copyBenchmark = (repositoryRoot: string, sourceRoot: string): void => {
  const benchmarkSource = HostFiles.join(repositoryRoot, "scripts", "benchmark")
  const benchmarkDestination = HostFiles.join(sourceRoot, "scripts", "benchmark")
  for (const relative of benchmarkFiles)
    HostFiles.copy(HostFiles.join(benchmarkSource, relative), HostFiles.join(benchmarkDestination, relative))
}

const removeBenchmarkOverlay = (sourceRoot: string): void => {
  const benchmarkDestination = HostFiles.join(sourceRoot, "scripts", "benchmark")
  for (const relative of benchmarkFiles) HostFiles.remove(HostFiles.join(benchmarkDestination, relative))
  HostFiles.remove(HostFiles.join(sourceRoot, ".semantic-output-identity.json"))
}

type RunCommand = typeof run

export const install = (input: {
  readonly sourceRoot: string
  readonly cacheDirectory: string
  readonly execute?: RunCommand
}): void => {
  const source = HostFiles.resolve(input.sourceRoot)
  const cache = HostFiles.resolve(input.cacheDirectory)
  const execute = input.execute ?? run
  if (cache === source || cache.startsWith(`${source}/`))
    throw new Error("Bun install cache must be outside the provisioned source root")
  HostFiles.remove(HostFiles.join(source, ".bun-install-cache"))
  HostFiles.remove(cache)
  HostFiles.mkdir(cache)
  execute(["bun", "install", "--linker=isolated"], source, {
    BUN_INSTALL_CACHE_DIR: cache,
    NODE_OPTIONS: "",
    NODE_PATH: "",
  })
}

const verifyCandidateLock = (root: string): void => {
  const lock = HostFiles.read(HostFiles.join(root, "bun.lock"))
  if (lock.includes("npmjs.org/tenetkit")) throw new Error("candidate source resolved a TenetKit package from npm")
  for (const packageName of tenetkitPackages) {
    const filename = `${packageName.replace("@tenetkit/", "tenetkit-")}-0.20.2.tgz`
    if (!lock.includes(filename)) throw new Error(`candidate source lock does not name ${filename}`)
  }
}

const copyCurrentSource = (repositoryRoot: string, destination: string): void => {
  HostFiles.remove(destination)
  HostFiles.mkdir(destination)
  const files = run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], repositoryRoot)
    .split("\0")
    .filter((file) => file.length > 0)
  for (const file of files) {
    const source = HostFiles.join(repositoryRoot, file)
    if (HostFiles.exists(source)) HostFiles.copy(source, HostFiles.join(destination, file))
  }
}

const pinCandidateTarballs = (sourceRoot: string, releaseDirectory: string): void => {
  const manifestPath = HostFiles.join(sourceRoot, "package.json")
  const manifest = JSON.parse(HostFiles.read(manifestPath)) as {
    readonly overrides?: Readonly<Record<string, string>>
    readonly workspaces: { readonly catalog: Readonly<Record<string, string>>; readonly [key: string]: unknown }
    readonly [key: string]: unknown
  }
  const tarballs = Object.fromEntries(
    tenetkitReleasePackages.map((packageName) => [
      packageName,
      `file:${HostFiles.join(releaseDirectory, `${packageName.replace("@tenetkit/", "tenetkit-")}-0.20.2.tgz`)}`,
    ]),
  )
  HostFiles.write(
    manifestPath,
    `${JSON.stringify(
      {
        ...manifest,
        overrides: { ...manifest.overrides, ...tarballs },
        workspaces: { ...manifest.workspaces, catalog: { ...manifest.workspaces.catalog, ...tarballs } },
      },
      null,
      2,
    )}\n`,
  )
  HostFiles.remove(HostFiles.join(sourceRoot, "bun.lock"))
}

const gitIdentity = (root: string) => ({
  root: HostFiles.resolve(root),
  commit: run(["git", "rev-parse", "HEAD"], root).trim(),
  describe: run(["git", "describe", "--always", "--dirty", "--tags"], root).trim(),
  status: run(["git", "status", "--short"], root),
})

export const setup = (input: {
  readonly repositoryRoot: string
  readonly output: string
  readonly candidateRelease: string
}) => {
  const repositoryRoot = HostFiles.resolve(input.repositoryRoot)
  const output = HostFiles.resolve(input.output)
  const candidateRelease = HostFiles.resolve(input.candidateRelease)
  const sourceOld = HostFiles.join(output, "sources", "rika-v0.5.3")
  const sourceNew = HostFiles.join(output, "sources", "rika-current")
  const baselineInstallCache = HostFiles.join(output, "install-cache", "baseline")
  const candidateInstallCache = HostFiles.join(output, "install-cache", "candidate")
  HostFiles.mkdir(HostFiles.dirname(sourceOld))
  if (!HostFiles.exists(HostFiles.join(sourceOld, ".git")))
    run(["git", "worktree", "add", "--detach", sourceOld, "v0.5.3"], repositoryRoot)
  if (
    run(["git", "rev-parse", "HEAD"], sourceOld).trim() !==
    run(["git", "rev-parse", "v0.5.3^{commit}"], repositoryRoot).trim()
  )
    throw new Error("baseline source worktree is not detached at v0.5.3")
  removeBenchmarkOverlay(sourceOld)
  if (run(["git", "status", "--short"], sourceOld).trim().length > 0)
    throw new Error("baseline source worktree is not clean before installing the benchmark overlay")

  const evidence = releaseInventory(candidateRelease)
  const baselineIdentity = {
    source: "baseline",
    sourceKind: "detached-rika-source",
    rika: gitIdentity(sourceOld),
    tenetkit: { kind: "published", version: "0.20.2" },
  }
  const candidateIdentity = {
    source: "candidate",
    sourceKind: "copied-current-rika-source",
    rika: gitIdentity(repositoryRoot),
    tenetkit: { kind: "full-local-release-inventory", releaseDirectory: candidateRelease, evidence },
  }

  copyBenchmark(repositoryRoot, sourceOld)
  HostFiles.write(
    HostFiles.join(sourceOld, ".semantic-output-identity.json"),
    `${JSON.stringify(baselineIdentity, null, 2)}\n`,
  )
  install({ sourceRoot: sourceOld, cacheDirectory: baselineInstallCache })

  copyCurrentSource(repositoryRoot, sourceNew)
  pinCandidateTarballs(sourceNew, candidateRelease)
  copyBenchmark(repositoryRoot, sourceNew)
  HostFiles.write(
    HostFiles.join(sourceNew, ".semantic-output-identity.json"),
    `${JSON.stringify(candidateIdentity, null, 2)}\n`,
  )
  install({ sourceRoot: sourceNew, cacheDirectory: candidateInstallCache })
  verifyCandidateLock(sourceNew)

  return {
    baselineConsumer: sourceOld,
    candidateConsumer: sourceNew,
    baselineIdentity: HostFiles.join(sourceOld, ".semantic-output-identity.json"),
    candidateIdentity: HostFiles.join(sourceNew, ".semantic-output-identity.json"),
    sourceOld,
    sourceNew,
    baselineInstallCache,
    candidateInstallCache,
    candidatePackages: evidence.packages.length,
  }
}
