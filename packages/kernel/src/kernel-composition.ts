import { KernelPool, KernelStateStore } from "@batonfx/repl"
import { BunKernelPool, workerModule } from "@batonfx/repl/bun"
import { HostBindingRegistry } from "@batonfx/repl"
import { Duration, Layer } from "effect"
import type { FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import * as KernelBootstrap from "./kernel-bootstrap"
import { make as makeModules, type BindingRequirements, type Options as ModuleOptions } from "./binding/binding-modules"
import { make as makeProfile, type Options as ProfileOptions } from "./kernel-profile-registration"
import { layer as stateStoreLayer } from "./kernel-state-store-file-system"

/**
 * A Session must reuse its worker across Runs, so the kernel is held well beyond one cell. With a
 * zero time-to-live the pool releases the kernel the instant a cell's scope closes and every cell
 * silently gets a fresh worker: plain values still return through snapshot restore, so it looks
 * correct while module bindings and live handles are silently dropped.
 */
export const defaultIdleTimeToLive = Duration.minutes(5)

export interface Options extends ProfileOptions {
  readonly workspaceDigest: string
  readonly servers: ModuleOptions["servers"]
  readonly skills?: NonNullable<ProfileOptions["environment"]>["skills"]
  readonly runtimeCommand?: string
  readonly workerModule?: string
  readonly startTimeoutMillis?: number
  readonly interruptGraceMillis?: number
  readonly maxConcurrentBoots?: number
  readonly idleTimeToLive?: Duration.Input
  readonly environment?: Readonly<Record<string, string>>
}

const moduleOptions = (options: Options): ModuleOptions => ({
  workspace: options.workspace,
  workspaceDigest: options.workspaceDigest,
  trustMode: options.trustMode ?? "trusted-local",
  servers: options.servers,
})

/**
 * The profile a pool is built from carries the same environment the surface is mounted over, so a
 * kernel never runs cells against a skill set or server set the epoch was not reconstructed from.
 */
const profileOptions = (options: Options): ProfileOptions => ({
  ...options,
  environment: { ...(options.skills === undefined ? {} : { skills: options.skills }), servers: options.servers },
})

/** The mounted `rika.*` surface, closed over the services that back it. */
export const bindings = (
  options: ModuleOptions,
): Layer.Layer<HostBindingRegistry.HostBindingRegistry, HostBindingRegistry.HostBindingConflict, BindingRequirements> =>
  HostBindingRegistry.layer(makeModules(options))

/** Best-effort namespace persistence under the profile data root. */
export const state = (
  dataRoot: string,
): Layer.Layer<KernelStateStore.KernelStateStore, never, FileSystem.FileSystem | Path.Path> => stateStoreLayer(dataRoot)

/**
 * One Server-scoped pool of Bun kernels, one per Session.
 *
 * `workerModule` is resolved by `@batonfx/repl/bun` against its own module URL: the worker is not an
 * importable entrypoint and its layout is an implementation detail, so a host must never name a dist
 * path itself. A host whose modules are compiled into a single executable is the exception — that URL
 * no longer names a file anything can spawn — so it supplies the path it shipped the worker to.
 */
export const pool = (
  options: Options,
): Layer.Layer<
  KernelPool.KernelPool,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  BunKernelPool.layer({
    profile: makeProfile(profileOptions(options)),
    runtimeCommand: options.runtimeCommand ?? "bun",
    workerModule: options.workerModule ?? workerModule,
    startTimeoutMillis: options.startTimeoutMillis ?? 20_000,
    bootstrap: KernelBootstrap.source(),
    interruptGraceMillis: options.interruptGraceMillis ?? 250,
    maxConcurrentBoots: options.maxConcurrentBoots ?? 4,
    idleTimeToLive: options.idleTimeToLive ?? defaultIdleTimeToLive,
    environment: options.environment ?? {},
  }).pipe(Layer.provide(state(options.dataRoot)))

/**
 * The kernel a Rika Execution runs cells in, plus the surface those cells can call.
 *
 * The surface is a dependency of the pool rather than its sibling. A pool reads its surface from
 * its own build context, and merged layers build independently, so a sibling surface would be
 * invisible: the pool would mount nothing, every cell would boot with no `rika` at all, and it
 * would do so silently, because an absent surface is indistinguishable from one a host chose not
 * to supply.
 */
export const layer = (
  options: Options,
): Layer.Layer<
  KernelPool.KernelPool | HostBindingRegistry.HostBindingRegistry,
  HostBindingRegistry.HostBindingConflict,
  BindingRequirements | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> => {
  const surface = bindings(moduleOptions(options))
  return Layer.merge(pool(options).pipe(Layer.provide(surface)), surface)
}
