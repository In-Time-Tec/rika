import { hasLiveSubagentWork, recoveryRetrySchedule } from "./relay-recovery-policy"
import { reconcileUnsafeRecovery } from "./relay-execution-recovery"
import { createHash } from "node:crypto"
import { Deferred, Duration, Effect, Scope } from "effect"
import { Client, Ids, PromptAssembler } from "@relayfx/sdk"

export const makePromptAssemblerLayer = (input: {
  readonly relayClient: Deferred.Deferred<Client.Interface>
  readonly recoveryScope: Scope.Scope
  readonly childSettlementGrace: Duration.Duration
  readonly defaultPromptAssembler: PromptAssembler.Interface
}) => {
  const { relayClient, recoveryScope, childSettlementGrace, defaultPromptAssembler } = input
  return PromptAssembler.layer({
    assemble: (assembleInput) =>
      Effect.gen(function* () {
        const assembled = yield* defaultPromptAssembler.assemble(assembleInput)
        const metadata = assembleInput.agent.metadata
        const execution = metadata?.rika_execution_id
        if (metadata?.rika_agent_depth !== 0 || typeof execution !== "string") return assembled
        const hash = createHash("sha256").update(assembled.system).digest("hex")
        const client = yield* Deferred.await(relayClient)
        const inspection = yield* client.executions.inspect(Ids.ExecutionId.make(execution)).pipe(
          Effect.tapError(() =>
            Effect.logWarning("execution.recovery.classification.retrying").pipe(
              Effect.annotateLogs({ "rika.execution.id": execution }),
            ),
          ),
          Effect.retry({ schedule: recoveryRetrySchedule }),
          Effect.orDie,
        )
        const unsafe = hasLiveSubagentWork(inspection)
        yield* Effect.logInfo("execution.context.baseline.assembled").pipe(
          Effect.annotateLogs({
            "rika.context.baseline.hash": hash,
            "rika.execution.id": execution,
            "rika.recovery.quarantined": unsafe,
          }),
        )
        if (unsafe) {
          yield* reconcileUnsafeRecovery({
            client,
            execution,
            childSettlementGrace,
          }).pipe(Effect.forkIn(recoveryScope))
          return yield* Effect.never
        }
        return assembled
      }),
  })
}
