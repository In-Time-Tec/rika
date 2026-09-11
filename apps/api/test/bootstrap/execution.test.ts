import { expect, it } from "@effect/vitest"
import { currentExecutorPolicy } from "@rika/product/executor-policy"
import { Effect } from "effect"
import { loadExecutionConfig } from "../../src/bootstrap/execution-config"
import { makeExecutionDependencies } from "../../src/bootstrap/execution"
import { boxTemplateBuildId } from "../../src/executor/box-preparation"
import { executionEnvironment } from "./execution.harness"
import { makeProductionHarness, orbBinding, productionConfig } from "./production.harness"

it.effect("constructs real execution services without allocating a workspace or resolving provider credentials", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeProductionHarness()
      const config = {
        ...productionConfig,
        identity: { ...productionConfig.identity, baseUrl: "http://127.0.0.1:3456" },
      }
      const execution = yield* loadExecutionConfig(executionEnvironment, false)
      const dependencies = yield* makeExecutionDependencies({ config, execution })(harness.services)
      expect(dependencies.executorPolicy).toEqual(currentExecutorPolicy)
      expect(dependencies.productPlacement).toEqual({
        templateBuildId: boxTemplateBuildId(execution.box.policy.template),
        providerScope: execution.box.providerScope,
      })
      const workspace = yield* dependencies.orbWorkspace(orbBinding)
      expect(workspace.binding).toEqual(orbBinding.workspaceBinding)
      expect(yield* dependencies.boxGateway.ready(workspace.binding)).toBeUndefined()
      expect(harness.state.contextAllocations).toBe(0)
      expect(harness.state.repositoryReads).toBe(0)
      expect(harness.state.orbAllocations).toBe(0)
    }),
  ),
)
