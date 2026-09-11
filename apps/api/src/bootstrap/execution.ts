import * as BoxProvider from "@rika/box-executor/provider"
import * as BoxBootstrap from "@rika/box-executor/bootstrap"
import * as BoxWorkspaceInputClient from "@rika/box-executor/workspace-input"
import * as CredentialCipher from "@rika/credential-vault/provider"
import * as AppJwt from "@rika/github-app/app-jwt"
import * as Installation from "@rika/github-app/installation-service"
import * as InstallationToken from "@rika/github-app/installation-token"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as WorkspaceSeedVault from "@rika/workspace-input/vault"
import * as Authorization from "@rika/product/hosted-authorization"
import { currentExecutorPolicy } from "@rika/product/executor-policy"
import { Clock, Context, Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import * as BoxBinding from "../executor/box-binding"
import * as BoxEnrollment from "../executor/box-enrollment"
import * as BoxPreparation from "../executor/box-preparation"
import * as BoxWorkspaceInput from "../executor/box-workspace-input"
import * as Repositories from "../product/repositories"
import * as WorkspaceSeeds from "../product/workspace-seeds"
import * as RuntimeContext from "../runtime/context"
import type { ApiV2ProductionConfig } from "./config"
import type { ExecutionConfig } from "./execution-config"
import {
  ApiV2ProductionStartupError,
  type ApiV2ProductionDependencies,
  type ApiV2ProductionDependenciesFactory,
} from "./production"

export const makeExecutionDependencies =
  ({
    config,
    execution,
  }: {
    readonly config: ApiV2ProductionConfig
    readonly execution: ExecutionConfig
  }): ApiV2ProductionDependenciesFactory =>
  (services) =>
    Effect.gen(function* () {
      const http = yield* Layer.build(FetchHttpClient.layer)
      const github = yield* Layer.build(
        Layer.mergeAll(
          Installation.installationLayer({ appId: execution.github.appId }),
          InstallationToken.installationTokenLayer(),
        ).pipe(
          Layer.provide(
            AppJwt.appJwtJoseLayer({ issuer: String(execution.github.appId), privateKey: execution.github.privateKey }),
          ),
          Layer.provide(Layer.succeedContext(http)),
        ),
      )
      const cipher = yield* CredentialCipher.makeProviderCredentialCipher({
        encodedKey: execution.providerCredentialKey,
      })
      const workspaceInputs = yield* Layer.build(
        WorkspaceSeedVault.layerWorkspaceSeedVault({ encryptionKey: execution.workspaceInputKey }).pipe(
          Layer.provide(WorkspaceSeedVault.layerS3ObjectStore(config.runtimeStorage)),
          Layer.provide(BunServices.layer),
        ),
      )
      const authorization = Context.get(
        yield* Layer.build(Authorization.AuthorizationPolicy.layer),
        Authorization.AuthorizationPolicy,
      )
      const box = yield* BoxEnrollment.makeBoxGateway({
        publicUrl: config.identity.baseUrl,
        crypto: services.crypto,
        current: BoxBinding.makeBoxBindingReader({
          assignments: services.boxAssignments,
          environment: config.environment,
        }),
      })
      const provider = BoxProvider.makeBoxHttpProvider({
        baseUrl: execution.box.baseUrl,
        apiKey: execution.box.apiKey,
        transport: BoxProvider.bunFetchTransport,
      })
      const enrollment = BoxBootstrap.makeBoxWorkspaceEnrollment({
        baseUrl: execution.box.baseUrl,
        apiKey: execution.box.apiKey,
        transport: BoxProvider.bunFetchTransport,
        authority: box.enrollment,
        runner: {
          buildId: currentExecutorPolicy.buildId,
          command: ["/usr/local/bin/rika-executor", "box", "--bootstrap-stdin"],
        },
        workspacePath: "/home/user/workspace",
      })
      const platform = yield* Layer.build(BunServices.layer)
      const repositories = Repositories.makeProductRepositories({
        store: services.repositoryBindings,
        installations: Context.get(github, Installation.Installation),
        tokens: Context.get(github, InstallationToken.InstallationToken),
        http: Context.get(http, HttpClient.HttpClient),
      })
      const workspaceInput = BoxWorkspaceInput.makeBoxWorkspaceInputInitializer({
        client: yield* Effect.try({
          try: () =>
            BoxWorkspaceInputClient.makeBoxWorkspaceInputClient({
              baseUrl: execution.box.baseUrl,
              apiKey: execution.box.apiKey,
              transport: BoxProvider.bunFetchTransport,
            }),
          catch: () =>
            ApiV2ProductionStartupError.make({
              dependency: "composition",
              message: "Box workspace input endpoint is invalid",
            }),
        }),
        capture: repositories.capture,
        vault: Context.get(workspaceInputs, WorkspaceSeedVault.WorkspaceSeedVault),
        platform,
      })
      const dependencies: ApiV2ProductionDependencies = {
        context: RuntimeContext.makeApiV2RuntimeContextFactory({
          product: services.product,
          credentials: services.providerCredentials,
          cipher,
          model: execution.model,
          httpClientLayer: Layer.succeedContext(http),
          prepareWorkspace: BoxPreparation.makeBoxPreparation({
            assignments: services.boxAssignments,
            provider,
            enrollment,
            workspaceInput: workspaceInput.ensure,
            policy: execution.box.policy,
            providerScope: execution.box.providerScope,
          }),
        }),
        orbWorkspace: (binding) => Effect.succeed(box.gateway.executor(binding.workspaceBinding)),
        boxGateway: box.gateway,
        executorPolicy: currentExecutorPolicy,
        repositories,
        productPlacement: {
          templateBuildId: BoxPreparation.boxTemplateBuildId(execution.box.policy.template),
          providerScope: execution.box.providerScope,
        },
        workspaceSeeds: WorkspaceSeeds.makeWorkspaceSeedService({
          product: services.product,
          repositories: services.repositoryBindings,
          authorization,
          vault: Context.get(workspaceInputs, WorkspaceSeedVault.WorkspaceSeedVault),
          crypto: services.crypto,
          clock: yield* Clock.Clock,
        }),
      }
      return dependencies
    }).pipe(
      Effect.mapError(() =>
        ApiV2ProductionStartupError.make({
          dependency: "composition",
          message: "Execution services could not be initialized",
        }),
      ),
    )
