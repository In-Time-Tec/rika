import { Context, Data, Effect, Layer, Redacted, Scope } from "effect"

export class HostedWorkerListenerError extends Data.TaggedError("HostedWorkerListenerError")<{
  readonly message: string
}> {}

export interface HostedWorkerListenerService {
  readonly listen: (
    channel: string,
    onNotify: (payload: string) => void,
    onListen: () => void,
  ) => Effect.Effect<void, HostedWorkerListenerError, Scope.Scope>
}

export class HostedWorkerListener extends Context.Service<HostedWorkerListener, HostedWorkerListenerService>()(
  "@rika/api/hosted/worker-listener/HostedWorkerListener",
) {
  static readonly layerTest = Layer.succeed(
    this,
    this.of({
      listen: (_channel, _onNotify, onListen) => Effect.sync(onListen),
    }),
  )
}

const failure = () => new HostedWorkerListenerError({ message: "PostgreSQL worker listener failed" })

export const layer = (databaseUrl: Redacted.Redacted<string>) =>
  Layer.effect(
    HostedWorkerListener,
    Effect.gen(function* () {
      const sql = yield* Effect.acquireRelease(
        Effect.sync(() => new Bun.SQL(Redacted.value(databaseUrl), { max: 1 })),
        (client) => Effect.tryPromise(() => client.close()).pipe(Effect.ignore),
      )
      const listen: HostedWorkerListenerService["listen"] = (channel, onNotify, onListen) =>
        Effect.acquireRelease(
          Effect.tryPromise({
            try: () => sql.listen(channel, onNotify, onListen),
            catch: failure,
          }),
          (subscription) => Effect.tryPromise(() => subscription.unlisten()).pipe(Effect.ignore),
        ).pipe(Effect.asVoid)
      return HostedWorkerListener.of({ listen })
    }),
  )
