import { KernelPool, KernelStateStore } from "tenetkit/repl"
import { BunKernelPool, workerModule, workerSupportModules } from "tenetkit/repl/bun"

/**
 * Where the kernel worker lives in an ordinary install. A packaging step needs it to ship the worker
 * beside a compiled binary, and only the package that owns the worker can answer where it is.
 */
export const defaultWorkerModules: {
  readonly worker: string
  readonly support: ReadonlyArray<string>
} = { worker: workerModule, support: workerSupportModules }

/**
 * Where a kernel's worker and the runtime that runs it live, given whether the module path this
 * package resolves still names a file. It does not in a host compiled into one executable, and that
 * host ships both beside itself, so the absence is what tells the two apart.
 */
export const kernelBinaries = (input: {
  readonly resolvedWorkerExists: boolean
  readonly executableDirectory: string
  readonly join: (directory: string, name: string) => string
}): { readonly workerModule?: string; readonly runtimeCommand?: string } =>
  input.resolvedWorkerExists
    ? {}
    : {
        workerModule: input.join(input.executableDirectory, ".rika-kernel-worker.js"),
        runtimeCommand: input.join(input.executableDirectory, ".rika-kernel-runtime"),
      }
import { HostBindingRegistry } from "tenetkit/repl"
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
 * `workerModule` is resolved by `tenetkit/repl/bun` against its own module URL: the worker is not an
 * importable entrypoint and its layout is an implementation detail, so a host must never name a dist
 * path itself. A host whose modules are compiled into a single executable is the exception — that URL
 * no longer names a file anything can spawn — so it supplies the path it shipped the worker to.
 */
export const pool = (
  options: Options,
): Layer.Layer<
  KernelPool.KernelPool | KernelStateStore.KernelStateStore,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  (() => {
    const stateStore = state(options.dataRoot)
    return Layer.merge(
      BunKernelPool.layer({
        profile: makeProfile(profileOptions(options)),
        runtimeCommand: options.runtimeCommand ?? "bun",
        workerModule: options.workerModule ?? workerModule,
        startTimeoutMillis: options.startTimeoutMillis ?? 20_000,
        bootstrap: KernelBootstrap.source(),
        interruptGraceMillis: options.interruptGraceMillis ?? 250,
        maxConcurrentBoots: options.maxConcurrentBoots ?? Number.POSITIVE_INFINITY,
        idleTimeToLive: options.idleTimeToLive ?? defaultIdleTimeToLive,
        environment: options.environment ?? {},
      }).pipe(Layer.provide(stateStore)),
      stateStore,
    )
  })()

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
  KernelPool.KernelPool | KernelStateStore.KernelStateStore | HostBindingRegistry.HostBindingRegistry,
  HostBindingRegistry.HostBindingConflict,
  BindingRequirements | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> => {
  const surface = bindings(moduleOptions(options))
  return Layer.merge(pool(options).pipe(Layer.provide(surface)), surface)
}
