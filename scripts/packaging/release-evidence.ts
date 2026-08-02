import type { PackageTarget } from "./package-target-contract"

export interface ReleaseArtifact {
  readonly target: PackageTarget
  readonly archive: string
  readonly sha256: string
  readonly bytes: number
}

export interface ReleaseEvidence {
  readonly schemaVersion: 1
  readonly version: string
  readonly revision: string
  readonly bun: string
  readonly artifacts: ReadonlyArray<ReleaseArtifact>
}
