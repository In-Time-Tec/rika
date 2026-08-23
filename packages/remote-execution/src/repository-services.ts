import {
  RepositoryService as RepositoryServiceSchema,
  type RepositoryService,
} from "@rika/product/workspace-capability"
import {
  Context,
  Crypto,
  Deferred,
  Effect,
  Encoding,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Ref,
  Schema,
  Scope,
  Semaphore,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import type { Fence } from "./protocol"

const StoredService = Schema.Struct({ ...RepositoryServiceSchema.fields, desired: Schema.Boolean })
const Snapshot = Schema.Struct({ version: Schema.Literal(1), services: Schema.Array(StoredService) })
const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(Snapshot))
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(Snapshot))

export interface StoredService extends RepositoryService {
  readonly desired: boolean
}

export class RepositoryServiceError extends Schema.TaggedError<RepositoryServiceError>()("RepositoryServiceError", {
  kind: Schema.Literals(["conflict", "driver", "invalid", "missing", "storage"]),
  message: Schema.String,
}) {}

export interface RepositoryInterface {
  readonly get: (serviceId: string) => Effect.Effect<StoredService | undefined, RepositoryServiceError>
  readonly list: Effect.Effect<ReadonlyArray<StoredService>, RepositoryServiceError>
  readonly save: (service: StoredService) => Effect.Effect<void, RepositoryServiceError>
}

export class Repository extends Context.Service<Repository, RepositoryInterface>()(
  "@rika/remote-execution/repository-services/Repository",
) {}

export interface RunningService {
  readonly exit: Effect.Effect<number, RepositoryServiceError>
}

export interface DriverInterface {
  readonly start: (service: RepositoryService) => Effect.Effect<RunningService, RepositoryServiceError, Scope.Scope>
}

export class Driver extends Context.Service<Driver, DriverInterface>()(
  "@rika/remote-execution/repository-services/Driver",
) {}

export interface Interface {
  readonly ensure: (service: RepositoryService) => Effect.Effect<void, RepositoryServiceError>
  readonly stop: (serviceId: string) => Effect.Effect<void, RepositoryServiceError>
  readonly resume: Effect.Effect<void, RepositoryServiceError>
}

export class RepositoryServices extends Context.Service<RepositoryServices, Interface>()(
  "@rika/remote-execution/repository-services/RepositoryServices",
) {}

const sameService = (left: RepositoryService, right: RepositoryService) =>
  left.command === right.command &&
  left.cwd === right.cwd &&
  left.args.length === right.args.length &&
  left.args.every((argument, index) => argument === right.args[index])

export const layer: Layer.Layer<RepositoryServices, RepositoryServiceError, Driver | Repository> = Layer.effect(
  RepositoryServices,
  Effect.gen(function* () {
    const driver = yield* Driver
    const repository = yield* Repository
    const scope = yield* Effect.scope
    const lock = yield* Semaphore.make(1)
    const supervisors = yield* Ref.make(new Map<string, Fiber.Fiber<void, never>>())

    const start = Effect.fn("RepositoryServices.start")(function* (service: RepositoryService) {
      const started = yield* Deferred.make<void, RepositoryServiceError>()
      const supervisor = Effect.gen(function* () {
        while (true) {
          yield* Effect.scoped(
            driver.start(service).pipe(
              Effect.tap(() => Deferred.succeed(started, undefined)),
              Effect.flatMap((running) => running.exit),
              Effect.tapError((error) => Deferred.fail(started, error)),
            ),
          ).pipe(Effect.result)
          yield* Effect.sleep("100 millis")
        }
      })
      const fiber = yield* Effect.forkIn(supervisor, scope)
      yield* Ref.update(supervisors, (current) => new Map(current).set(service.serviceId, fiber))
      yield* Deferred.await(started)
    })

    const startOnce = Effect.fn("RepositoryServices.startOnce")(function* (service: RepositoryService) {
      if ((yield* Ref.get(supervisors)).has(service.serviceId)) return
      yield* start(service)
    })

    const ensure = Effect.fn("RepositoryServices.ensure")((service: RepositoryService) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const known = yield* repository.get(service.serviceId)
          if (known !== undefined && !sameService(known, service))
            return yield* RepositoryServiceError.make({
              kind: "conflict",
              message: `Repository service ${service.serviceId} already has a different definition`,
            })
          yield* repository.save({ ...service, desired: true })
          yield* startOnce(service)
        }),
      ),
    )

    const stop = Effect.fn("RepositoryServices.stop")((serviceId: string) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const known = yield* repository.get(serviceId)
          if (known === undefined)
            return yield* RepositoryServiceError.make({
              kind: "missing",
              message: `Repository service ${serviceId} does not exist`,
            })
          yield* repository.save({ ...known, desired: false })
          const supervisor = yield* Ref.modify(supervisors, (current) => {
            const fiber = current.get(serviceId)
            if (fiber === undefined) return [undefined, current] as const
            const next = new Map(current)
            next.delete(serviceId)
            return [fiber, next] as const
          })
          if (supervisor !== undefined) yield* Fiber.interrupt(supervisor)
        }),
      ),
    )

    const resume = lock.withPermits(1)(
      Effect.flatMap(repository.list, (services) =>
        Effect.forEach(
          services.filter((service) => service.desired),
          (service) => startOnce(service).pipe(Effect.ignore),
          { discard: true },
        ),
      ),
    )

    return RepositoryServices.of({ ensure, stop, resume })
  }),
)

const assignmentIdentity = (fence: Fence) => `${fence.target}\0${fence.assignmentId}\0${fence.assignmentGeneration}`

export const repositoryLayer = (options: {
  readonly stateDirectory: string
  readonly fence: Fence
}): Layer.Layer<Repository, RepositoryServiceError, Crypto.Crypto | FileSystem.FileSystem> =>
  Layer.effect(
    Repository,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const crypto = yield* Crypto.Crypto
      const digest = Encoding.encodeHex(
        yield* crypto
          .digest("SHA-256", new TextEncoder().encode(assignmentIdentity(options.fence)))
          .pipe(
            Effect.mapError(() =>
              RepositoryServiceError.make({ kind: "storage", message: "Could not identify repository services" }),
            ),
          ),
      )
      const directory = `${options.stateDirectory}/services`
      const filename = `${directory}/assignment-${digest}.json`
      const lock = yield* Semaphore.make(1)
      yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(
        Effect.andThen(fileSystem.chmod(directory, 0o700)),
        Effect.mapError(() =>
          RepositoryServiceError.make({ kind: "storage", message: "Could not secure repository service state" }),
        ),
      )
      const exists = yield* fileSystem
        .exists(filename)
        .pipe(
          Effect.mapError(() =>
            RepositoryServiceError.make({ kind: "storage", message: "Could not inspect repository service state" }),
          ),
        )
      const loaded = exists
        ? yield* fileSystem.readFileString(filename).pipe(
            Effect.flatMap(decodeSnapshot),
            Effect.mapError(() =>
              RepositoryServiceError.make({ kind: "storage", message: "Repository service state is invalid" }),
            ),
          )
        : { version: 1 as const, services: [] }
      const services = yield* Ref.make(
        new Map(loaded.services.map((service) => [service.serviceId, service as StoredService] as const)),
      )
      const persist = Effect.fn("RepositoryServices.Repository.persist")(function* (next: Map<string, StoredService>) {
        const temporary = `${filename}.tmp-${process.pid}`
        const content = yield* encodeSnapshot({ version: 1, services: [...next.values()] }).pipe(
          Effect.mapError(() =>
            RepositoryServiceError.make({ kind: "storage", message: "Could not encode repository service state" }),
          ),
        )
        yield* fileSystem.writeFileString(temporary, content, { mode: 0o600 }).pipe(
          Effect.andThen(fileSystem.chmod(temporary, 0o600)),
          Effect.andThen(fileSystem.rename(temporary, filename)),
          Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
          Effect.mapError(() =>
            RepositoryServiceError.make({ kind: "storage", message: "Could not persist repository service state" }),
          ),
        )
        yield* Ref.set(services, next)
      })
      const get = (serviceId: string) => Effect.map(Ref.get(services), (current) => current.get(serviceId))
      const list = Effect.map(Ref.get(services), (current) => [...current.values()])
      const save = (service: StoredService) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const next = new Map(yield* Ref.get(services)).set(service.serviceId, service)
            yield* persist(next)
          }),
        )
      return Repository.of({ get, list, save })
    }),
  )

export const driverLayer = (options: {
  readonly workspaceRoot: string
  readonly workspaceUser: string
}): Layer.Layer<Driver, never, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    Driver,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const start = Effect.fn("RepositoryServices.Driver.start")(function* (service: RepositoryService) {
        const root = yield* fileSystem
          .realPath(options.workspaceRoot)
          .pipe(
            Effect.mapError(() =>
              RepositoryServiceError.make({ kind: "driver", message: "Workspace root is unavailable" }),
            ),
          )
        const candidate = path.isAbsolute(service.cwd) ? path.resolve(service.cwd) : path.resolve(root, service.cwd)
        const cwd = yield* fileSystem
          .realPath(candidate)
          .pipe(
            Effect.mapError(() =>
              RepositoryServiceError.make({ kind: "invalid", message: "Repository service directory does not exist" }),
            ),
          )
        if (cwd !== root && !cwd.startsWith(`${root}${path.sep}`))
          return yield* RepositoryServiceError.make({
            kind: "invalid",
            message: "Repository service directory is outside the Workspace",
          })
        const handle = yield* spawner
          .spawn(
            ChildProcess.make("sudo", ["-n", "-u", options.workspaceUser, service.command, ...service.args], {
              cwd,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            }),
          )
          .pipe(
            Effect.mapError(() =>
              RepositoryServiceError.make({ kind: "driver", message: "Could not start repository service" }),
            ),
          )
        return {
          exit: handle.exitCode.pipe(
            Effect.map(Number),
            Effect.mapError(() =>
              RepositoryServiceError.make({ kind: "driver", message: "Could not observe repository service" }),
            ),
          ),
        }
      })
      return Driver.of({ start })
    }),
  )
