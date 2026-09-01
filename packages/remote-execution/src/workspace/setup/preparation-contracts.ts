import { Effect, Schema } from "effect"
import type {
  AccessWire,
  EncodedArchive,
  RepositoryCheckoutWire,
  WorkspacePreparationPhase,
} from "../../protocol/messages"
import type { SetupCacheKey } from "../artifact/archive"
import type { Credential } from "../credential-broker"
import type { WorkspaceError } from "../error"

export interface Assignment {
  readonly access: AccessWire
  readonly workspaceId: string
  readonly wakeId: string
  readonly cold: boolean
  readonly attempt: number
  readonly retry: boolean
  readonly templateBuildId: string
  readonly checkout: RepositoryCheckoutWire | null
}

export interface NativeToolRuntimeIdentity {
  readonly digest: string
}

export interface Reporter {
  readonly started: (phase: WorkspacePreparationPhase) => Effect.Effect<void, WorkspaceError, never>
  readonly output: (
    phase: WorkspacePreparationPhase,
    stream: "stdout" | "stderr",
    text: string,
    truncated: boolean,
  ) => Effect.Effect<void, WorkspaceError, never>
}

export interface Options {
  readonly root?: string
  readonly workspaceCommandPrefix?: ReadonlyArray<string>
  readonly credentialRoot?: string
  readonly setupTimeout?: number
  readonly resumeTimeout?: number
  readonly resumeBlockingWindow?: number
  readonly stateDirectory: string
  readonly nativeToolRuntime: NativeToolRuntimeIdentity
  readonly assignment: Assignment
  readonly reporter: Reporter
  readonly credential: (purpose: "git-read" | "github-read") => Effect.Effect<Credential, WorkspaceError, never>
  readonly revoke: (purpose: "git-read" | "github-read") => Effect.Effect<void, WorkspaceError, never>
  readonly environment?: Readonly<Record<string, string>>
  readonly environmentDigest?: string
  readonly seed?: { readonly seedId: string; readonly archive: EncodedArchive }
  readonly restore?: { readonly checkpointId: string; readonly archive: EncodedArchive }
  readonly setupCache?: {
    readonly ownerId: string
    readonly load: (key: SetupCacheKey) => Effect.Effect<EncodedArchive | null, never, never>
    readonly store: (key: SetupCacheKey, archive: EncodedArchive) => Effect.Effect<void, never, never>
  }
  readonly secretValues?: ReadonlySet<string>
}

export const HookEvidence = Schema.Struct({
  digest: Schema.NullOr(Schema.String),
  commitSha: Schema.NullOr(Schema.String),
  buildDigest: Schema.String,
  environmentDigest: Schema.String,
  startedAt: Schema.Int,
  finishedAt: Schema.Int,
  outcome: Schema.Literals(["missing", "completed", "continued"]),
})

export const Marker = Schema.Struct({
  version: Schema.Literal(2),
  assignmentId: Schema.String,
  assignmentGeneration: Schema.Int,
  workspaceId: Schema.String,
  templateBuildId: Schema.String,
  nativeToolRuntimeDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  repositoryId: Schema.NullOr(Schema.String),
  commitSha: Schema.NullOr(Schema.String),
  setupState: Schema.Literals(["completed", "failed"]),
  setup: HookEvidence,
  resume: Schema.NullOr(HookEvidence),
  lastWakeId: Schema.NullOr(Schema.String),
})
export type Marker = typeof Marker.Type

export const MarkerCodec = {
  encode: Schema.encodeSync(Schema.fromJsonString(Marker)),
  decode: Schema.decodeUnknownEffect(Schema.fromJsonString(Marker)),
} as const
