import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as PgClient from "@effect/sql-pg/PgClient"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { ThreadId } from "@rika/product/hosted-model"
import { HostedTurnWorkerStore, layer as storeLayer } from "@rika/product-store/turn-worker-store"
import { Clock, Config, Deferred, Effect, Fiber, Layer, Redacted, Schema } from "effect"
import { expect, it } from "@effect/vitest"
import { HostedTurnWorker, layer as workerLayer } from "../../src/hosted/thread/turn-worker"
import { layerTest as runtimeLayer } from "../../src/hosted/worker-runtime"
import { command } from "./thread/protocol/commands.harness"
import { live, setup, withDatabase } from "./thread/protocol/database.harness"
import { actor, ownerId, threadId } from "./thread/protocol/values.harness"

// Opt-in, isolated PostgreSQL experiment. The fixture creates/migrates/drops a fresh database.
// Delays are deliberately scaled below the production 120s lease; these are mechanisms, not a capacity benchmark.
it.live.skipIf(!live)(
  "distinguishes acquisition delay, SQL lock delay, stalls and Turn fencing",
  () =>
    Effect.gen(function* () {
      const configured = new URL(yield* Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL"))
      expect(["localhost", "127.0.0.1", "[::1]"]).toContain(configured.hostname)
      const exit = yield* withDatabase((pool, url) =>
        Effect.gen(function* () {
          const protocol = yield* setup(pool)
          for (let index = 0; index < 32; index += 1) {
            const id = index === 0 ? threadId : ThreadId.make(`contention-thread-${index}`)
            if (index !== 0) {
              yield* Effect.tryPromise(() =>
                pool.query(
                  `
                WITH product_thread AS (
                  INSERT INTO rika_threads (id, owner_id, workspace, title, created_at, updated_at)
                  SELECT $1, owner_id, workspace, title, created_at, updated_at FROM rika_threads WHERE id = $2
                  RETURNING id
                )
                INSERT INTO rika_hosted_threads (id, owner_id, workspace_id, created_by_user_id, executor_kind,
                  inherit_project_grants, created_at)
                SELECT $1, owner_id, workspace_id, created_by_user_id, executor_kind, inherit_project_grants, created_at
                FROM rika_hosted_threads WHERE id = $2`,
                  [id, threadId],
                ),
              )
              yield* protocol.initializeThread({ ownerId, threadId: id, actor })
            }
            const admitted = { ...command(index === 0 ? "contention" : `contention-${index}`, "0"), threadId: id }
            yield* protocol.admitCommand(admitted)
            const link = { threadId: id, turnId: admitted.turnId, runId: `contention-run-${index}` }
            const linkJson = yield* Schema.encodeEffect(Schema.fromJsonString(ExecutionGateway.ExecutionLink))(link)
            const preparedJson = yield* Schema.encodeEffect(Schema.fromJsonString(ExecutionGateway.PreparedTurn))({
              ...link,
              rootAdmissionJson: "{}",
            })
            yield* Effect.tryPromise(() =>
              pool.query(
                `
      INSERT INTO rika_turns (id, thread_id, prompt, status, created_at, updated_at, execution_route_json, execution_link_json)
      VALUES ($1, $2, 'contention', 'accepted', extract(epoch from clock_timestamp()) * 1000, 1, '{}', $3)`,
                [admitted.turnId, id, linkJson],
              ),
            )
            yield* Effect.tryPromise(() =>
              pool.query(
                `
      UPDATE rika_hosted_thread_protocol_commands SET state = 'completed', result = '{}', event_cursor = 0,
        completed_at = clock_timestamp(), work_state = 'turn-activation-pending', admission_status = 'accepted',
        prepared_turn_json = $1 WHERE command_id = $2`,
                [preparedJson, admitted.commandId],
              ),
            )
          }

          const data = PgClient.layer({
            url: Redacted.make(url),
            maxConnections: 10,
            applicationName: "rika-contention",
          })
          const context = yield* Layer.build(storeLayer.pipe(Layer.provideMerge(data)))
          yield* Effect.gen(function* () {
            const sql = yield* PgClient.PgClient
            const store = yield* HostedTurnWorkerStore
            const clock = yield* Clock.Clock
            const now = () => Number(clock.currentTimeNanosUnsafe()) / 1_000_000
            const leaseMillis = 1_500
            const metrics: Array<Record<string, string | number | boolean | undefined>> = []
            let loopDelayMs = 0
            yield* Effect.gen(function* () {
              const start = now()
              yield* Effect.sleep(20)
              loopDelayMs = Math.max(loopDelayMs, now() - start - 20)
            }).pipe(Effect.forever, Effect.forkScoped)
            const claim = (token: string) =>
              store
                .claimNext({ workerId: "contention", claimToken: token, leaseMillis })
                .pipe(
                  Effect.flatMap((value) =>
                    value === undefined ? Effect.die("Expected runnable Turn") : Effect.succeed(value),
                  ),
                )
            const probe = Effect.scoped(
              Effect.gen(function* () {
                const requested = now()
                const connection = yield* sql.reserve
                const acquired = now()
                yield* connection.execute("SELECT 1", [], undefined)
                return { acquireMs: acquired - requested, sqlMs: now() - acquired }
              }),
            )

            // Real worker loop, real SQL claims and renewals; only the execution gateway is held open.
            yield* Effect.scoped(
              Effect.gen(function* () {
                const activated = yield* Deferred.make<void>()
                const renewed = yield* Deferred.make<void>()
                const finish = yield* Deferred.make<void>()
                const renewals = new Map<string, number>()
                const renewalMs: number[] = []
                let activations = 0
                const worker = yield* Layer.build(
                  workerLayer({ workerId: "healthy", leaseMillis, concurrency: 32, fallbackIntervalMillis: 50 }).pipe(
                    Layer.provide(
                      Layer.mergeAll(
                        runtimeLayer,
                        BunCrypto.layer,
                        Layer.succeed(HostedTurnWorkerStore, {
                          ...store,
                          renew: (owned, millis) =>
                            Effect.gen(function* () {
                              const start = now()
                              const ok = yield* store.renew(owned, millis)
                              renewalMs.push(now() - start)
                              expect(ok).toBe(true)
                              renewals.set(owned.input.turnId, (renewals.get(owned.input.turnId) ?? 0) + 1)
                              if (renewals.size === 32 && [...renewals.values()].every((count) => count >= 3))
                                yield* Deferred.succeed(renewed, undefined)
                              return ok
                            }),
                        }),
                        ExecutionGateway.layerTest({
                          activateTurn: () =>
                            Effect.gen(function* () {
                              activations += 1
                              if (activations === 32) yield* Deferred.succeed(activated, undefined)
                              yield* Deferred.await(finish)
                              return "running" as const
                            }),
                        }),
                      ),
                    ),
                  ),
                )
                yield* Deferred.await(activated)
                const load = yield* Effect.forEach(
                  Array.from({ length: 32 }),
                  () =>
                    Effect.gen(function* () {
                      for (let query = 0; query < 60; query += 1) yield* sql`SELECT pg_sleep(0.01)`
                    }),
                  {
                    concurrency: 32,
                  },
                ).pipe(Effect.forkScoped)
                const sample = yield* probe
                yield* Deferred.await(renewed)
                yield* Fiber.join(load)
                yield* Deferred.succeed(finish, undefined)
                const service = yield* HostedTurnWorker.pipe(Effect.provide(worker))
                for (let attempt = 0; attempt < 100; attempt += 1) {
                  if ((yield* service.status).active === 0) break
                  yield* Effect.sleep(10)
                }
                expect((yield* service.status).lastFailure).toBeUndefined()
                expect((yield* service.status).active).toBe(0)
                expect(
                  (yield* sql<{ count: number }>`SELECT count(*)::int AS count
                  FROM rika_hosted_thread_protocol_commands WHERE work_state IS NULL`)[0]?.count,
                ).toBe(32)
                renewalMs.sort((a, b) => a - b)
                metrics.push({
                  phase: "healthy-worker",
                  activations,
                  renewalCount: renewalMs.length,
                  renewalP95Ms: renewalMs[Math.floor(renewalMs.length * 0.95)],
                  renewalMaxMs: renewalMs.at(-1),
                  loopDelayMs,
                  ...sample,
                })
              }),
            )
            // Reset only this fixture's completed activation for independent failure experiments.
            yield* sql`UPDATE rika_hosted_thread_protocol_commands SET work_state = 'turn-activation-requested'
        WHERE command_id = 'contention'`

            // All ten application connections are reserved but run no SQL: acquisition wait alone.
            loopDelayMs = 0
            const pooledClaim = yield* claim("pool-wait")
            const held = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            let holders = 0
            const saturation = yield* Effect.forEach(
              Array.from({ length: 10 }),
              () =>
                Effect.scoped(
                  Effect.gen(function* () {
                    yield* sql.reserve
                    holders += 1
                    if (holders === 10) yield* Deferred.succeed(held, undefined)
                    yield* Deferred.await(release)
                  }),
                ),
              { concurrency: 10 },
            ).pipe(Effect.forkScoped)
            yield* Deferred.await(held)
            const acquireProbe = yield* probe.pipe(Effect.forkScoped)
            const renewal = yield* store.renew(pooledClaim, leaseMillis).pipe(Effect.forkScoped)
            const started = now()
            yield* Effect.sleep(2_200)
            const active = yield* Effect.tryPromise(() =>
              pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE application_name = 'rika-contention' AND state = 'active'`),
            )
            expect(active.rows[0]?.count).toBe(0)
            yield* Deferred.succeed(release, undefined)
            yield* Fiber.join(saturation)
            const acquired = yield* Fiber.join(acquireProbe)
            expect(yield* Fiber.join(renewal)).toBe(false)
            metrics.push({
              phase: "pool-wait",
              ...acquired,
              elapsedMs: now() - started,
              activeSqlWhileBlocked: active.rows[0]?.count,
              loopDelayMs,
              renewed: false,
            })

            // An expired token cannot renew; a replacement claim must fence both renewal and completion.
            const replacement = yield* claim("replacement")
            expect(yield* store.renew(pooledClaim, leaseMillis)).toBe(false)
            expect((yield* store.completeActivation(pooledClaim, "running", 1).pipe(Effect.result))._tag).toBe(
              "Failure",
            )
            expect(yield* store.renew(replacement, leaseMillis)).toBe(true)
            yield* store.release(replacement)

            // SQL lock wait, with nine free application connections. Observe PostgreSQL's wait classification.
            const lockResults: Array<{ renewed: boolean; live: boolean | undefined; expected: boolean }> = []
            for (const scenario of ["updated-row", "locked-only", "short-lock"] as const) {
              loopDelayMs = 0
              const lockedClaim = yield* claim(scenario)
              const locker = yield* Effect.acquireRelease(
                Effect.tryPromise(() => pool.connect()),
                (client) =>
                  Effect.tryPromise(() => client.query("ROLLBACK")).pipe(
                    Effect.orDie,
                    Effect.ensuring(Effect.sync(() => client.release())),
                  ),
              )
              yield* Effect.tryPromise(() => locker.query("BEGIN"))
              yield* Effect.tryPromise(() =>
                locker.query(
                  scenario === "updated-row"
                    ? `UPDATE rika_hosted_thread_protocol_commands
        SET result = result WHERE command_id = 'contention'`
                    : `SELECT 1 FROM rika_hosted_thread_protocol_commands WHERE command_id = 'contention' FOR UPDATE`,
                ),
              )
              const lockStart = now()
              const blockedRenewal = yield* store.renew(lockedClaim, leaseMillis).pipe(Effect.forkScoped)
              let lockObserved = false
              for (let attempt = 0; attempt < 100; attempt += 1) {
                const activity = yield* Effect.tryPromise(() =>
                  pool.query(`SELECT wait_event_type FROM pg_stat_activity
          WHERE application_name = 'rika-contention' AND state = 'active' AND wait_event_type = 'Lock'`),
                )
                if (activity.rowCount !== 0) {
                  lockObserved = true
                  break
                }
                yield* Effect.sleep(10)
              }
              expect(lockObserved).toBe(true)
              const unlockedProbe = yield* probe
              yield* Effect.sleep(scenario === "short-lock" ? 100 : 2_200)
              yield* Effect.tryPromise(() => locker.query("COMMIT"))
              const lockRenewed = yield* Fiber.join(blockedRenewal)
              const expiry = yield* sql<{ live: boolean }>`SELECT claim_expires_at > clock_timestamp() AS live
        FROM rika_hosted_thread_protocol_commands WHERE command_id = 'contention'`
              metrics.push({
                phase: scenario,
                ...unlockedProbe,
                elapsedMs: now() - lockStart,
                loopDelayMs,
                waitEvent: "Lock",
                renewed: lockRenewed,
                liveAtReturn: expiry[0]?.live,
              })
              lockResults.push({ renewed: lockRenewed, live: expiry[0]?.live, expected: scenario === "short-lock" })
              yield* store.release(lockedClaim)
            }

            // A synchronous stall can expire a lease without pool or SQL contention.
            const stalledClaim = yield* claim("event-loop")
            const timerStarted = yield* Deferred.make<void>()
            const timer = yield* Effect.gen(function* () {
              const start = now()
              yield* Deferred.succeed(timerStarted, undefined)
              yield* Effect.sleep(10)
              return now() - start
            }).pipe(Effect.forkScoped)
            yield* Deferred.await(timerStarted)
            const stallStart = now()
            while (now() - stallStart < 2_200) {
              /* deliberate bounded event-loop stall */
            }
            const timerDelayMs = yield* Fiber.join(timer)
            expect(yield* store.renew(stalledClaim, leaseMillis)).toBe(false)
            metrics.push({ phase: "event-loop", timerDelayMs, ...(yield* probe), renewed: false })
            yield* Effect.logInfo({ leaseMillis, poolSize: 10, metrics })
            for (const result of lockResults) {
              expect(result.renewed).toBe(result.expected)
              expect(result.live).toBe(result.expected)
            }
          }).pipe(Effect.scoped, Effect.provide(context))
        }).pipe(Effect.scoped, Effect.timeout(23_000), Effect.exit),
      )
      // Let the fixture close its pools and drop the database before surfacing a failed experiment.
      if (exit._tag === "Failure") return yield* Effect.failCause(exit.cause)
    }).pipe(Effect.timeout(25_000)),
  30_000,
)
