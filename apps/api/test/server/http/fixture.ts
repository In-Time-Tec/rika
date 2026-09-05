import { Effect, Schema, Stream } from "effect"
import { IdentityDirectoryError, type Account, type CliDeviceDirectory, type IdentityRuntime } from "@rika/identity"
import type { HttpDependencies } from "../../../src/server/http"
import { HostedProductError, type HostedProductService } from "../../../src/hosted/product"
import type { Runtime as Executor } from "../../../src/executor/service"
import type { Interface as ControllerService } from "@rika/e2b-executor/controller"
import type { Gateway } from "../../../src/executor/gateway"
import type { RunnerGateway } from "../../../src/runner/gateway"
const account: Account = {
  user: {
    id: "user-1",
    name: "Rika User",
    email: "rika@example.com",
    emailVerified: true,
    image: null,
  },
  memberships: [
    {
      id: "member-1",
      role: "owner",
      createdAt: "2026-08-19T00:00:00.000Z",
      organization: {
        id: "organization-1",
        name: "Rika",
        slug: "rika",
        logo: null,
      },
    },
  ],
}

const runtime = (userId: string | undefined): IdentityRuntime => ({
  handle: () => Effect.succeed(new Response(null, { status: 204 })),
  identify: () => Effect.succeed(userId === undefined ? undefined : { userId }),
  protectedResourceMetadata: Effect.succeed({
    resource: "https://api.example.com/api/v1",
    dpop_bound_access_tokens_required: true,
  }),
})

const devices: CliDeviceDirectory = {
  register: () => Effect.void,
  discard: () => Effect.void,
  authenticate: () => Effect.void.pipe(Effect.as<string | undefined>(undefined)),
  list: () => Effect.succeed([]),
  revoke: () => Effect.succeed(false),
  revokeAll: () => Effect.void,
}

const product: HostedProductService = {
  ready: Effect.void,
  activatePrincipal: () => Effect.void,
  authorizeOwner: () => Effect.die("unused"),
  authorizeThread: () => Effect.fail(HostedProductError.make({ kind: "not-found", message: "Thread unavailable" })),
  threadExecutionContext: () => Effect.die("unused"),
  projects: () => Effect.succeed([]),
  createProject: () => Effect.die("unused"),
  registerRunner: () => Effect.die("unused"),
  setRemoteThreadCreation: () => Effect.die("unused"),
  pollRunner: () => Effect.die("unused"),
  createConnection: () => Effect.succeed({ threadId: "thread-1" }),
  admitRun: () => Effect.die("unused"),
  admitAuthorizedRun: () => Effect.die("unused"),
  cancelRunAdmission: () => Effect.die("unused"),
  cancelAuthorizedRunAdmission: () => Effect.die("unused"),
}

const recovery: HttpDependencies["recovery"] = {
  inspect: () => Effect.die("unused"),
  resolve: () => Effect.die("unused"),
}

const unusedController: ControllerService = {
  provision: () => Effect.die("unused"),
  replace: () => Effect.die("unused"),
  resume: () => Effect.die("unused"),
  pause: () => Effect.die("unused"),
  kill: () => Effect.die("unused"),
  portal: () => Effect.die("unused"),
  hello: () => Effect.die("unused"),
  reconnect: () => Effect.die("unused"),
  validateAccess: () => Effect.die("unused"),
  heartbeat: () => Effect.die("unused"),
  checkpoint: () => Effect.die("unused"),
  credential: () => Effect.die("unused"),
  revokeCredential: () => Effect.die("unused"),
  workspace: () => Effect.die("unused"),
  ready: () => Effect.die("unused"),
  loadSetupCache: () => Effect.die("unused"),
  storeSetupCache: () => Effect.die("unused"),
  activatePhase: () => Effect.die("unused"),
  cleanupOrphans: Effect.die("unused"),
}
const unusedGateway: Gateway = {
  receive: () => Effect.die("unused"),
  disconnected: () => Effect.die("unused"),
  active: () => Effect.die("unused"),
  execute: () => Effect.die("unused"),
  cancel: () => Effect.die("unused"),
  workspace: () => Effect.die("unused"),
  sendPty: () => Effect.die("unused"),
  ptyEvents: () => Stream.empty,
  retryPreparation: () => Effect.die("unused"),
  quiesce: () => Effect.die("unused"),
  pushBranch: () => Effect.die("unused"),
}
const unusedRunnerGateway: RunnerGateway = {
  receive: () => Effect.die("unused"),
  disconnected: () => Effect.die("unused"),
  active: () => Effect.die("unused"),
  withReadySession: () => Effect.die("unused"),
  execute: () => Effect.die("unused"),
  cancel: () => Effect.die("unused"),
}

const executor: Executor = {
  controller: unusedController,
  gateway: unusedGateway,
  runnerGateway: unusedRunnerGateway,
  admitRunner: () => Effect.die("unused"),
  admitRun: () => Effect.die("unused"),
  runTool: () => Effect.die("unused"),
  cancelTool: () => Effect.die("unused"),
  pause: () => Effect.die("unused"),
  resume: () => Effect.die("unused"),
  replace: () => Effect.die("unused"),
  ready: Effect.void,
}

const execution = {
  check: Effect.succeed({ backend: "postgres" as const, source: "test", workerId: "test-worker" }),
  status: Effect.succeed({
    scan: { _tag: "Starting" as const },
    wakeup: { _tag: "Starting" as const },
    lastFallbackAt: undefined,
    lastFailure: undefined,
    active: 0,
    capacity: 1,
    oldestClaimAt: undefined,
    scanAgeMillis: undefined,
    wakeupAgeMillis: undefined,
    lastFallbackAgeMillis: undefined,
    oldestClaimAgeMillis: undefined,
    lastFailureAgeMillis: undefined,
    availableCapacity: 1,
    execution: { worker: "execution" },
    turn: { worker: "turn", active: 1, capacity: 1, oldestClaimAgeMillis: 10 },
    projection: { worker: "projection", active: 2, capacity: 2, oldestActiveProjectionAgeMillis: 20 },
  }),
}

const dependencies = (
  options: {
    readonly userId?: string
    readonly account?: Account
    readonly ready?: boolean
  } = {},
): HttpDependencies => ({
  identity: runtime(options.userId),
  directory: {
    ready: options.ready === false ? Effect.fail(IdentityDirectoryError.make({ operation: "readiness" })) : Effect.void,
    account: () => Effect.succeed(options.account),
  },
  devices,
  product,
  recovery,
  executor,
  execution,
  production: true,
})

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const ProjectsResponse = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      ownerId: Schema.String,
      owner: Schema.Struct({ kind: Schema.String, organizationId: Schema.String }),
      name: Schema.String,
      slug: Schema.String,
    }),
  ),
})

const cliRegistrationBody = {
  reference_id: "cli-device:019d1a56-286d-7000-8000-000000000001",
  token_endpoint_auth_method: "none",
  grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
  scope: "openid profile email offline_access account",
  resource: "https://api.example.com/api/v1",
  dpop_jkt: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
  jwk: {
    kty: "EC",
    crv: "P-256",
    x: "public-x",
    y: "public-y",
  },
} as const

export const httpFixture = {
  account,
  runtime,
  devices,
  product,
  recovery,
  unusedController,
  unusedGateway,
  unusedRunnerGateway,
  executor,
  execution,
  dependencies,
  encodeJson,
  ProjectsResponse,
  cliRegistrationBody,
}
