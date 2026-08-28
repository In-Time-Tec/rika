import { Vault } from "@rika/e2b-executor/checkpoint"
import { WorkspaceSeed, type WorkspaceSeedRepository } from "@rika/product/executor-assignment"
import type { EncodedArchive } from "@rika/remote-execution/protocol"
import { ProductRepository } from "@rika/product-store/product-repository"
import { Clock, Context, Crypto, DateTime, Effect, Layer, Schema } from "effect"
import type { AuthenticatedPrincipal } from "./product"

export class HostedWorkspaceSeedError extends Schema.TaggedError<HostedWorkspaceSeedError>()(
  "HostedWorkspaceSeedError",
  {
    kind: Schema.Literals(["invalid", "unavailable"]),
    message: Schema.String,
  },
) {}

export interface HostedWorkspaceSeedsService {
  readonly stage: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly archive: EncodedArchive
    readonly sourceRepository: WorkspaceSeedRepository | null
  }) => Effect.Effect<
    { readonly id: string; readonly contentDigest: string; readonly sizeBytes: number; readonly expiresAt: string },
    HostedWorkspaceSeedError
  >
}

export class HostedWorkspaceSeeds extends Context.Service<HostedWorkspaceSeeds, HostedWorkspaceSeedsService>()(
  "@rika/api/hosted/workspace-seeds/HostedWorkspaceSeeds",
) {}

const lifetimeMillis = 10 * 60 * 1_000
const failure = (message: string) => HostedWorkspaceSeedError.make({ kind: "unavailable", message })
const vaultFailure = (kind: "corrupt" | "crypto" | "missing" | "object" | "scope" | "size", message: string) =>
  HostedWorkspaceSeedError.make({ kind: kind === "corrupt" || kind === "size" ? "invalid" : "unavailable", message })

export const layer = Layer.effect(
  HostedWorkspaceSeeds,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const vault = yield* Vault
    const repository = yield* ProductRepository
    return HostedWorkspaceSeeds.of({
      stage: Effect.fn("HostedWorkspaceSeeds.stage")(function* (input) {
        const id = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(() => failure("Workspace seed could not be identified")),
        )
        const stored = yield* vault
          .storeWorkspaceSeed(id, input.archive)
          .pipe(Effect.mapError((error) => vaultFailure(error.kind, error.message)))
        const nowMillis = yield* Clock.currentTimeMillis
        const now = DateTime.toDate(DateTime.makeUnsafe(nowMillis))
        const expiresAt = DateTime.toDate(DateTime.makeUnsafe(nowMillis + lifetimeMillis))
        const manifest = WorkspaceSeed.make({ id, sourceRepository: input.sourceRepository, ...stored })
        yield* repository
          .stageWorkspaceSeed({
            id,
            userId: input.principal.userId,
            deviceId: input.principal.deviceId,
            clientId: input.principal.clientId,
            manifest,
            expiresAt,
            now,
          })
          .pipe(
            Effect.mapError((error) => failure(error.message)),
            Effect.tapError(() => vault.removeWorkspaceSeed(id, stored).pipe(Effect.ignore)),
          )
        return {
          id,
          contentDigest: stored.archiveDigest,
          sizeBytes: stored.archiveSizeBytes,
          expiresAt: expiresAt.toISOString(),
        }
      }),
    })
  }),
)
