import type { HostedThreadApplicationService } from "../../../../src/hosted/thread/application"
import type { HostedProductService } from "../../../../src/hosted/product"
import { HostedWorkspace } from "../../../../src/hosted/environment/workspace"
import { Effect } from "effect"

export const fakeProduct = (overrides: Partial<HostedProductService> = {}): HostedProductService => ({
  ready: Effect.void,
  projects: () => Effect.die("unused"),
  createProject: () => Effect.die("unused"),
  createConnection: () => Effect.die("unused"),
  registerRunner: () => Effect.die("unused"),
  setRemoteThreadCreation: () => Effect.die("unused"),
  pollRunner: () => Effect.die("unused"),
  admitRun: () => Effect.die("unused"),
  admitAuthorizedRun: () => Effect.die("unused"),
  cancelRunAdmission: () => Effect.die("unused"),
  cancelAuthorizedRunAdmission: () => Effect.die("unused"),
  authorizeOwner: () => Effect.die("unused"),
  authorizeReadOwner: () => Effect.die("unused"),
  authorizeReadThread: () => Effect.die("unused"),
  authorizeThread: () => Effect.die("unused"),
  threadExecutionContext: () => Effect.die("unused"),
  activatePrincipal: () => Effect.die("unused"),
  ...overrides,
})

export const fakeApplication = (
  overrides: Partial<HostedThreadApplicationService> = {},
): HostedThreadApplicationService => ({
  threads: () => Effect.die("unused"),
  preview: () => Effect.die("unused"),
  thread: () => Effect.die("unused"),
  interactive: () => Effect.die("unused"),
  snapshot: () => Effect.die("unused"),
  history: () => Effect.die("unused"),
  projectionCommitted: () => Effect.die("unused"),
  ...overrides,
})

export const fakeWorkspace = (
  pause: Effect.Effect<void> = Effect.die("unused"),
  resume: Effect.Effect<void> = Effect.die("unused"),
) =>
  HostedWorkspace.of({
    execute: () => Effect.die("unused"),
    pause: () => pause,
    resume: () => resume,
    portal: () => Effect.die("unused"),
  })
