import { readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Config, Diagnostics, SecretRedactor } from "@rika/core"
import { OrbStore, ProjectStore } from "@rika/persistence"
import { Ids, Orb } from "@rika/schema"
import { Context, Effect, Layer, Option, Schema, Semaphore, Stream } from "effect"
import * as SandboxClient from "./sandbox-client"

const repoRoot = "/home/user/repo"
const serverPort = 4587
const defaultTemplateId = "rika-orb"
const defaultIdleTimeoutSeconds = 300
const healthAttempts = 60
const resumeHealthAttempts = 15
const healthDelayMillis = 1_000
const setupCommand =
  "if [ -e .agents/setup ] && [ ! -x .agents/setup ]; then echo 'Lifecycle hook file must be executable' >&2; exit 126; fi; if [ -x .agents/setup ]; then .agents/setup; fi"
const resumeCommand =
  'if [ -e .agents/resume ] && [ ! -x .agents/resume ]; then echo \'Lifecycle hook file must be executable\' >&2; exit 126; fi; if [ ! -x .agents/resume ]; then echo \'Lifecycle hook skipped\' >&2; exit 0; fi; status_dir=$(mktemp -d); status_file="$status_dir/status"; (.agents/resume; code=$?; if [ -d "$status_dir" ]; then printf \'%s\' "$code" > "$status_file"; fi) & pid=$!; for _ in $(seq 1 100); do if [ -f "$status_file" ]; then code=$(cat "$status_file"); rm -rf "$status_dir"; wait "$pid" 2>/dev/null || true; exit "$code"; fi; sleep 0.1; done; echo \'Lifecycle hook detached after 10 seconds\' >&2; rm -rf "$status_dir"; disown "$pid" 2>/dev/null || true; exit 0'

export interface ProvisionInput extends Schema.Schema.Type<typeof ProvisionInput> {}
export const ProvisionInput = Schema.Struct({
  thread_id: Ids.ThreadId,
  project_id: Ids.ProjectId,
  workspace_root: Schema.String,
}).annotate({ identifier: "Rika.Orb.OrbManager.ProvisionInput" })

export class SystemError extends Schema.TaggedErrorClass<SystemError>()("OrbManagerSystemError", {
  message: Schema.String,
  operation: Schema.String,
}) {}

export class OrbProvisionError extends Schema.TaggedErrorClass<OrbProvisionError>()("OrbProvisionError", {
  message: Schema.String,
  step: Schema.String,
  orb_id: Schema.optional(Ids.OrbId),
  sandbox_id: Schema.optional(Schema.String),
}) {}

export interface System {
  readonly makeTempPath: Effect.Effect<string, SystemError>
  readonly createGitBundle: (input: {
    readonly workspaceRoot: string
    readonly path: string
  }) => Effect.Effect<Uint8Array, SystemError>
  readonly currentBranch: (workspaceRoot: string) => Effect.Effect<string, SystemError>
  readonly randomToken: Effect.Effect<string, SystemError>
  readonly health: (url: string, token: string) => Effect.Effect<void, SystemError>
  readonly sleep: (millis: number) => Effect.Effect<void>
}

export interface Interface {
  readonly provisionForThread: (input: ProvisionInput) => Effect.Effect<Orb.OrbRecord, OrbProvisionError>
  readonly pause: (orbId: Ids.OrbId) => Effect.Effect<Orb.OrbRecord, OrbProvisionError>
  readonly resume: (orbId: Ids.OrbId) => Effect.Effect<Orb.OrbRecord, OrbProvisionError>
  readonly kill: (orbId: Ids.OrbId) => Effect.Effect<Orb.OrbRecord, OrbProvisionError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/orb/OrbManager") {}

type SandboxOrbRecord = Orb.OrbRecord & { readonly sandbox_id: string }

export const layerWithSystem = (system: System) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const projects = yield* ProjectStore.Service
      const orbs = yield* OrbStore.Service
      const sandbox = yield* SandboxClient.Service
      const diagnostics = yield* Diagnostics.Service
      const redactor = Option.getOrUndefined(yield* Effect.serviceOption(SecretRedactor.Service))
      const registerSecrets = (entries: ReadonlyArray<SecretRedactor.Entry>) =>
        redactor === undefined ? Effect.void : redactor.register(entries)
      const resumeLocks = new Map<Ids.OrbId, Semaphore.Semaphore>()
      const resumeLocksMutex = yield* Semaphore.make(1)
      const resumeLockFor = (orbId: Ids.OrbId) =>
        resumeLocksMutex.withPermit(
          Effect.gen(function* () {
            const existing = resumeLocks.get(orbId)
            if (existing !== undefined) return existing
            const lock = yield* Semaphore.make(1)
            resumeLocks.set(orbId, lock)
            return lock
          }),
        )

      const provisionForThread: Interface["provisionForThread"] = Effect.fn("OrbManager.provisionForThread")(function* (
        input: ProvisionInput,
      ) {
        let orbId: Ids.OrbId | undefined
        let sandboxId: string | undefined
        const project = yield* step(
          "project",
          projects
            .get(input.project_id)
            .pipe(
              Effect.flatMap((record) =>
                record === undefined
                  ? Effect.fail(
                      new SystemError({ message: `Project ${input.project_id} not found`, operation: "project" }),
                    )
                  : Effect.succeed(record),
              ),
            ),
        )
        const templateId = yield* resolveTemplateId(config, project)
        const timeoutMs = yield* resolveTimeoutMs(config)
        const created = yield* step(
          "create_record",
          orbs.create({ thread_id: input.thread_id, project_id: input.project_id }),
        )
        orbId = created.orb_id

        return yield* Effect.gen(function* () {
          const createdSandbox = yield* step(
            "create_sandbox",
            sandbox.create({
              templateId,
              envs: {},
              metadata: { thread_id: input.thread_id, project_id: input.project_id },
              timeoutMs,
              lifecycle: { onTimeout: "pause", autoResume: false },
            }),
            { orbId },
          )
          sandboxId = createdSandbox.sandboxId
          yield* step("set_sandbox", orbs.setSandbox(orbId, sandboxId), { orbId, sandboxId })

          const projectSecrets = yield* step("secrets", projects.secretsForProvision(input.project_id), {
            orbId,
            sandboxId,
          })
          const processEnv = { ...project.env, ...projectSecrets }
          yield* registerSecrets(secretEntries(project.env, projectSecrets))
          yield* placeRepo({
            config,
            project,
            system,
            sandbox,
            input,
            sandboxId,
            processEnv,
            orbId,
          })

          const baseCommit = yield* readBaseCommit(sandbox, sandboxId, orbId)
          yield* step("base_commit", orbs.setBaseCommit(orbId, baseCommit), { orbId, sandboxId })
          yield* runSetup(sandbox, diagnostics, sandboxId, processEnv, orbId)
          const token = yield* step("token", system.randomToken, { orbId, sandboxId })
          yield* registerSecrets([{ label: "RIKA_ORB_TOKEN", value: token }])
          yield* startServer(sandbox, sandboxId, processEnv, token, baseCommit, orbId)
          const endpointUrl = yield* step("host_url", sandbox.hostUrl(sandboxId, serverPort), { orbId, sandboxId })
          yield* waitForHealth(system, endpointUrl, token, 0, orbId, sandboxId, healthAttempts)
          yield* step("endpoint", orbs.setEndpoint(orbId, { endpoint_url: endpointUrl, token }), { orbId, sandboxId })
          return yield* step("running", orbs.setStatus(orbId, "running"), { orbId, sandboxId })
        }).pipe(
          Effect.catch((error) =>
            cleanupAfterProvisionFailure(orbs, sandbox, orbId, sandboxId).pipe(
              Effect.flatMap(() => Effect.fail(error)),
            ),
          ),
        )
      })

      const requireSandboxId = Effect.fn("OrbManager.requireSandboxId")(function* (orbId: Ids.OrbId, stepName: string) {
        const record = yield* step(stepName, orbs.get(orbId), { orbId })
        if (record === undefined) {
          return yield* new OrbProvisionError({ message: `Orb ${orbId} not found`, step: stepName, orb_id: orbId })
        }
        if (record.sandbox_id === null) {
          return yield* new OrbProvisionError({ message: `Orb ${orbId} has no sandbox`, step: stepName, orb_id: orbId })
        }
        return record.sandbox_id
      })
      const requireOrbRecord = Effect.fn("OrbManager.requireOrbRecord")(function* (orbId: Ids.OrbId, stepName: string) {
        const record = yield* step(stepName, orbs.get(orbId), { orbId })
        if (record === undefined) {
          return yield* new OrbProvisionError({ message: `Orb ${orbId} not found`, step: stepName, orb_id: orbId })
        }
        const sandboxId = record.sandbox_id
        if (sandboxId === null) {
          return yield* new OrbProvisionError({ message: `Orb ${orbId} has no sandbox`, step: stepName, orb_id: orbId })
        }
        return { ...record, sandbox_id: sandboxId }
      })

      return Service.of({
        provisionForThread,
        pause: Effect.fn("OrbManager.pause")(function* (orbId: Ids.OrbId) {
          const sandboxId = yield* requireSandboxId(orbId, "pause")
          yield* step("pause", sandbox.pause(sandboxId), { orbId, sandboxId })
          return yield* step("pause_status", orbs.setStatus(orbId, "paused"), { orbId, sandboxId })
        }),
        resume: Effect.fn("OrbManager.resume")(function* (orbId: Ids.OrbId) {
          const resumeLock = yield* resumeLockFor(orbId)
          return yield* resumeLock.withPermit(
            Diagnostics.event(
              "orb.resume",
              (fields) =>
                Effect.gen(function* () {
                  const record = yield* requireOrbRecord(orbId, "resume")
                  const sandboxId = record.sandbox_id
                  fields.sandbox_id = sandboxId
                  if (record.status === "running") {
                    fields.status = "already_running"
                    return record
                  }
                  if (record.status !== "paused") {
                    return yield* new OrbProvisionError({
                      message: `Orb ${orbId} cannot resume from ${record.status}`,
                      step: "resume",
                      orb_id: orbId,
                      sandbox_id: sandboxId,
                    })
                  }
                  const endpoint = yield* resumeEndpoint(orbs, record)
                  yield* step("resume", sandbox.resume(sandboxId), { orbId, sandboxId })
                  const endpointUrl = yield* step("host_url", sandbox.hostUrl(sandboxId, serverPort), {
                    orbId,
                    sandboxId,
                  })
                  yield* ensureResumeHealth(
                    system,
                    sandbox,
                    projects,
                    record,
                    endpoint.token,
                    endpointUrl,
                    registerSecrets,
                  )
                  const updatedEndpoint = yield* step(
                    "endpoint",
                    orbs.setEndpoint(orbId, { endpoint_url: endpointUrl, token: endpoint.token }),
                    { orbId, sandboxId },
                  )
                  const hook = yield* runResumeHook(sandbox, sandboxId)
                  fields.hook_status = hook.status
                  if ("error" in hook && hook.error !== undefined) fields.hook_error = hook.error
                  if ("exitCode" in hook && hook.exitCode !== undefined) fields.hook_exit_code = hook.exitCode
                  return yield* step("resume_status", orbs.setStatus(updatedEndpoint.orb_id, "running"), {
                    orbId,
                    sandboxId,
                  })
                }),
              { orb_id: orbId },
            ).pipe(Effect.provideService(Diagnostics.Service, diagnostics)),
          )
        }),
        kill: Effect.fn("OrbManager.kill")(function* (orbId: Ids.OrbId) {
          const sandboxId = yield* requireSandboxId(orbId, "kill")
          yield* step("kill", sandbox.kill(sandboxId), { orbId, sandboxId })
          return yield* step("kill_status", orbs.setStatus(orbId, "killed"), { orbId, sandboxId })
        }),
      })
    }),
  )

export const provisionForThread = Effect.fn("OrbManager.provisionForThread.call")(function* (input: ProvisionInput) {
  const manager = yield* Service
  return yield* manager.provisionForThread(input)
})

export const pause = Effect.fn("OrbManager.pause.call")(function* (orbId: Ids.OrbId) {
  const manager = yield* Service
  return yield* manager.pause(orbId)
})

export const resume = Effect.fn("OrbManager.resume.call")(function* (orbId: Ids.OrbId) {
  const manager = yield* Service
  return yield* manager.resume(orbId)
})

export const kill = Effect.fn("OrbManager.kill.call")(function* (orbId: Ids.OrbId) {
  const manager = yield* Service
  return yield* manager.kill(orbId)
})

const step = <A, E, R>(
  stepName: string,
  effect: Effect.Effect<A, E, R>,
  context: { readonly orbId?: Ids.OrbId; readonly sandboxId?: string } = {},
): Effect.Effect<A, OrbProvisionError, R> =>
  effect.pipe(
    Effect.mapError(
      (error) =>
        new OrbProvisionError({
          message: messageFromUnknown(error),
          step: stepName,
          ...(context.orbId === undefined ? {} : { orb_id: context.orbId }),
          ...(context.sandboxId === undefined ? {} : { sandbox_id: context.sandboxId }),
        }),
    ),
  )

const resolveTemplateId = Effect.fn("OrbManager.resolveTemplateId")(function* (
  config: Config.Interface,
  project: Orb.ProjectRecord,
) {
  const configured = yield* config.requireEnv("RIKA_ORB_TEMPLATE").pipe(Effect.option)
  if (Option.isSome(configured) && configured.value.trim().length > 0) return configured.value.trim()
  if (project.template_id !== null && project.template_id.trim().length > 0) return project.template_id.trim()
  return defaultTemplateId
})

const resolveTimeoutMs = Effect.fn("OrbManager.resolveTimeoutMs")(function* (config: Config.Interface) {
  const configured = yield* config.requireEnv("RIKA_ORB_IDLE_TIMEOUT").pipe(Effect.option)
  if (Option.isNone(configured)) return defaultIdleTimeoutSeconds * 1_000
  const seconds = Number(configured.value)
  if (!Number.isInteger(seconds) || seconds <= 0) {
    return yield* new OrbProvisionError({
      message: `Invalid RIKA_ORB_IDLE_TIMEOUT ${configured.value}`,
      step: "config",
    })
  }
  return seconds * 1_000
})

const placeRepo = Effect.fn("OrbManager.placeRepo")(function* (input: {
  readonly config: Config.Interface
  readonly project: Orb.ProjectRecord
  readonly system: System
  readonly sandbox: SandboxClient.Interface
  readonly input: ProvisionInput
  readonly sandboxId: string
  readonly processEnv: Record<string, string>
  readonly orbId: Ids.OrbId
}) {
  const cloneMode = yield* input.config.requireEnv("RIKA_ORB_CLONE").pipe(Effect.option)
  if (Option.isSome(cloneMode) && cloneMode.value === "origin" && input.project.repo_origin.trim().length > 0) {
    yield* step(
      "repo_clone",
      runExec(
        input.sandbox,
        input.sandboxId,
        ["bash", "-lc", originCloneScript(input.project, input.processEnv)],
        { envs: gitCloneEnv(input.processEnv) },
        "repo_clone",
        input.orbId,
      ),
      { orbId: input.orbId, sandboxId: input.sandboxId },
    )
    return
  }

  const path = yield* step("repo_bundle_path", input.system.makeTempPath, {
    orbId: input.orbId,
    sandboxId: input.sandboxId,
  })
  const branch = yield* step("repo_branch", input.system.currentBranch(input.input.workspace_root), {
    orbId: input.orbId,
    sandboxId: input.sandboxId,
  })
  const bytes = yield* step(
    "repo_bundle",
    input.system.createGitBundle({ workspaceRoot: input.input.workspace_root, path }),
    {
      orbId: input.orbId,
      sandboxId: input.sandboxId,
    },
  )
  yield* step("repo_write", input.sandbox.writeFile(input.sandboxId, "/tmp/repo.bundle", bytes), {
    orbId: input.orbId,
    sandboxId: input.sandboxId,
  })
  const checkout =
    branch.trim().length === 0 ? "" : ` && git -C ${repoRoot} checkout -B ${shellQuote(branch.trim())} HEAD`
  yield* step(
    "repo_clone",
    runExec(
      input.sandbox,
      input.sandboxId,
      ["bash", "-lc", `git clone /tmp/repo.bundle ${repoRoot}${checkout}`],
      {},
      "repo_clone",
      input.orbId,
    ),
    { orbId: input.orbId, sandboxId: input.sandboxId },
  )
})

const readBaseCommit: (
  sandbox: SandboxClient.Interface,
  sandboxId: string,
  orbId: Ids.OrbId,
) => Effect.Effect<string, OrbProvisionError> = Effect.fn("OrbManager.readBaseCommit")(function* (
  sandbox: SandboxClient.Interface,
  sandboxId: string,
  orbId: Ids.OrbId,
) {
  const chunks = yield* collectExec(
    sandbox,
    sandboxId,
    ["git", "-C", repoRoot, "rev-parse", "HEAD"],
    {},
    "base_commit",
    orbId,
  )
  const commit = chunks
    .flatMap((chunk) => (chunk.type === "stdout" ? [chunk.data] : []))
    .join("")
    .trim()
  if (commit.length === 0) {
    return yield* new OrbProvisionError({
      message: "Base commit was empty",
      step: "base_commit",
      orb_id: orbId,
      sandbox_id: sandboxId,
    })
  }
  return commit
})

const runSetup: (
  sandbox: SandboxClient.Interface,
  diagnostics: Diagnostics.Interface,
  sandboxId: string,
  envs: Record<string, string>,
  orbId: Ids.OrbId,
) => Effect.Effect<void, OrbProvisionError> = Effect.fn("OrbManager.runSetup")(function* (
  sandbox: SandboxClient.Interface,
  diagnostics: Diagnostics.Interface,
  sandboxId: string,
  envs: Record<string, string>,
  orbId: Ids.OrbId,
) {
  const chunks = yield* collectExec(
    sandbox,
    sandboxId,
    ["bash", "-lc", setupCommand],
    { cwd: repoRoot, envs },
    "setup",
    orbId,
    (chunk) => emitSetupDiagnostics(diagnostics, sandboxId, chunk),
  )
  yield* Effect.succeed(chunks)
})

const startServer: (
  sandbox: SandboxClient.Interface,
  sandboxId: string,
  envs: Record<string, string>,
  token: string,
  baseCommit: string,
  orbId: Ids.OrbId,
) => Effect.Effect<void, OrbProvisionError> = Effect.fn("OrbManager.startServer")(function* (
  sandbox: SandboxClient.Interface,
  sandboxId: string,
  envs: Record<string, string>,
  token: string,
  baseCommit: string,
  orbId: Ids.OrbId,
) {
  const chunks = yield* collectExec(
    sandbox,
    sandboxId,
    [
      "rika",
      "server",
      "--host",
      "0.0.0.0",
      "--port",
      String(serverPort),
      "--token",
      token,
      "--workspace",
      repoRoot,
      "--orb",
      "--base-commit",
      baseCommit,
    ],
    { cwd: repoRoot, envs, background: true },
    "start_server",
    orbId,
  )
  if (!chunks.some((chunk) => chunk.type === "started")) {
    return yield* new OrbProvisionError({
      message: "Orb server did not start",
      step: "start_server",
      orb_id: orbId,
      sandbox_id: sandboxId,
    })
  }
  return undefined
})

const runExec: (
  sandbox: SandboxClient.Interface,
  sandboxId: string,
  cmd: ReadonlyArray<string>,
  opts: SandboxClient.ExecOptions,
  stepName: string,
  orbId: Ids.OrbId,
) => Effect.Effect<void, OrbProvisionError> = Effect.fn("OrbManager.runExec")(function* (
  sandbox: SandboxClient.Interface,
  sandboxId: string,
  cmd: ReadonlyArray<string>,
  opts: SandboxClient.ExecOptions,
  stepName: string,
  orbId: Ids.OrbId,
) {
  yield* collectExec(sandbox, sandboxId, cmd, opts, stepName, orbId)
})

const collectExec: (
  sandbox: SandboxClient.Interface,
  sandboxId: string,
  cmd: ReadonlyArray<string>,
  opts: SandboxClient.ExecOptions,
  stepName: string,
  orbId: Ids.OrbId,
  onChunk?: (chunk: SandboxClient.ExecChunk) => Effect.Effect<void>,
) => Effect.Effect<ReadonlyArray<SandboxClient.ExecChunk>, OrbProvisionError> = Effect.fn("OrbManager.collectExec")(
  function* (
    sandbox: SandboxClient.Interface,
    sandboxId: string,
    cmd: ReadonlyArray<string>,
    opts: SandboxClient.ExecOptions,
    stepName: string,
    orbId: Ids.OrbId,
    onChunk?: (chunk: SandboxClient.ExecChunk) => Effect.Effect<void>,
  ) {
    const chunks: Array<SandboxClient.ExecChunk> = []
    yield* step(
      stepName,
      sandbox.exec(sandboxId, cmd, opts).pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              chunks.push(chunk)
            })
            if (onChunk !== undefined) yield* onChunk(chunk)
          }),
        ),
      ),
      {
        orbId,
        sandboxId,
      },
    )
    const exit = chunks.find((chunk) => chunk.type === "exit")
    if (exit?.type === "exit" && exit.exitCode !== 0) {
      const output = execOutputLines(chunks).slice(-50)
      return yield* new OrbProvisionError({
        message:
          output.length === 0
            ? `Sandbox command exited with code ${exit.exitCode}`
            : `Sandbox command exited with code ${exit.exitCode}: ${output.join("\n")}`,
        step: stepName,
        orb_id: orbId,
        sandbox_id: sandboxId,
      })
    }
    return chunks
  },
)

const emitSetupDiagnostics = (
  diagnostics: Diagnostics.Interface,
  sandboxId: string,
  chunk: SandboxClient.ExecChunk,
): Effect.Effect<void> =>
  chunk.type === "stdout" || chunk.type === "stderr"
    ? Effect.forEach(
        chunk.data.split(/\r?\n/).filter((line: string) => line.length > 0),
        (line) =>
          diagnostics.emit({
            level: "info",
            message: `orb.setup.${chunk.type}`,
            data: { sandbox_id: sandboxId, line },
          }),
        { discard: true },
      )
    : Effect.void

const execOutputLines = (chunks: ReadonlyArray<SandboxClient.ExecChunk>): ReadonlyArray<string> =>
  chunks.flatMap((chunk) =>
    chunk.type === "stdout" || chunk.type === "stderr"
      ? chunk.data
          .split(/\r?\n/)
          .filter((line) => line.length > 0)
          .map((line) => `${chunk.type}: ${line}`)
      : [],
  )

const waitForHealth: (
  system: System,
  url: string,
  token: string,
  attempt: number,
  orbId: Ids.OrbId,
  sandboxId: string,
  maxAttempts: number,
) => Effect.Effect<void, OrbProvisionError> = Effect.fn("OrbManager.waitForHealth")(function* (
  system: System,
  url: string,
  token: string,
  attempt: number,
  orbId: Ids.OrbId,
  sandboxId: string,
  maxAttempts: number,
) {
  return yield* step("health", system.health(url, token), { orbId, sandboxId }).pipe(
    Effect.catch((error) =>
      attempt >= maxAttempts - 1
        ? Effect.fail(error)
        : system
            .sleep(healthDelayMillis)
            .pipe(Effect.flatMap(() => waitForHealth(system, url, token, attempt + 1, orbId, sandboxId, maxAttempts))),
    ),
  )
})

const resumeEndpoint = Effect.fn("OrbManager.resumeEndpoint")(function* (
  orbs: OrbStore.Interface,
  record: SandboxOrbRecord,
) {
  if (record.base_commit === null) {
    return yield* new OrbProvisionError({
      message: `Orb ${record.orb_id} has no base commit`,
      step: "resume_endpoint",
      orb_id: record.orb_id,
      sandbox_id: record.sandbox_id,
    })
  }
  const endpoint = yield* step("resume_endpoint", orbs.endpointCredentials(record.orb_id), {
    orbId: record.orb_id,
    sandboxId: record.sandbox_id,
  })
  if (endpoint === undefined) {
    return yield* new OrbProvisionError({
      message: `Orb ${record.orb_id} has no endpoint`,
      step: "resume_endpoint",
      orb_id: record.orb_id,
      sandbox_id: record.sandbox_id,
    })
  }
  return endpoint
})

const ensureResumeHealth = Effect.fn("OrbManager.ensureResumeHealth")(function* (
  system: System,
  sandbox: SandboxClient.Interface,
  projects: ProjectStore.Interface,
  record: SandboxOrbRecord,
  token: string,
  endpointUrl: string,
  registerSecrets: (entries: ReadonlyArray<SecretRedactor.Entry>) => Effect.Effect<void>,
) {
  const firstCheck = yield* Effect.result(
    waitForHealth(system, endpointUrl, token, 0, record.orb_id, record.sandbox_id, resumeHealthAttempts),
  )
  if (firstCheck._tag === "Success") return
  const process = yield* step("resume_process_env", resumeProcessEnv(projects, record), {
    orbId: record.orb_id,
    sandboxId: record.sandbox_id,
  })
  yield* registerSecrets(process.entries)
  yield* registerSecrets([{ label: "RIKA_ORB_TOKEN", value: token }])
  const baseCommit = record.base_commit
  if (baseCommit === null) {
    yield* new OrbProvisionError({
      message: `Orb ${record.orb_id} has no base commit`,
      step: "resume_start_server",
      orb_id: record.orb_id,
      sandbox_id: record.sandbox_id,
    })
  } else {
    yield* startServer(sandbox, record.sandbox_id, process.envs, token, baseCommit, record.orb_id)
    yield* waitForHealth(system, endpointUrl, token, 0, record.orb_id, record.sandbox_id, resumeHealthAttempts)
  }
})

const resumeProcessEnv = Effect.fn("OrbManager.resumeProcessEnv")(function* (
  projects: ProjectStore.Interface,
  record: SandboxOrbRecord,
) {
  const project = yield* projects.get(record.project_id)
  if (project === undefined) return { envs: {}, entries: [] }
  const secrets = yield* projects.secretsForProvision(record.project_id)
  return { envs: { ...project.env, ...secrets }, entries: secretEntries(project.env, secrets) }
})

type ResumeHookResult =
  | {
      readonly status: "skipped" | "ok" | "detached"
    }
  | {
      readonly status: "failed"
      readonly exitCode?: number
      readonly error?: string
    }

const runResumeHook: (sandbox: SandboxClient.Interface, sandboxId: string) => Effect.Effect<ResumeHookResult> =
  Effect.fn("OrbManager.runResumeHook")(function* (sandbox: SandboxClient.Interface, sandboxId: string) {
    const result = yield* Effect.result(
      sandbox.exec(sandboxId, ["bash", "-lc", resumeCommand], { cwd: repoRoot }).pipe(Stream.runCollect),
    )
    if (result._tag === "Failure") {
      return { status: "failed", error: messageFromUnknown(result.failure) } as const
    }
    const chunks = Array.from(result.success)
    const lines = execOutputLines(chunks)
    if (lines.some((line) => line.includes("Lifecycle hook skipped"))) {
      return { status: "skipped" } as const
    }
    if (lines.some((line) => line.includes("Lifecycle hook detached after 10 seconds"))) {
      return { status: "detached" } as const
    }
    const exit = chunks.find((chunk) => chunk.type === "exit")
    if (exit?.type === "exit" && exit.exitCode !== 0) {
      return { status: "failed", exitCode: exit.exitCode } as const
    }
    return { status: "ok" } as const
  })

const cleanupAfterProvisionFailure = (
  orbs: OrbStore.Interface,
  sandbox: SandboxClient.Interface,
  orbId: Ids.OrbId | undefined,
  sandboxId: string | undefined,
) => {
  if (orbId === undefined || sandboxId === undefined) return Effect.void
  return sandbox
    .kill(sandboxId)
    .pipe(Effect.ignore, Effect.andThen(orbs.setStatus(orbId, "killed").pipe(Effect.ignore)))
}

const secretEntries = (
  env: Record<string, string>,
  secrets: Record<string, string>,
): ReadonlyArray<SecretRedactor.Entry> => [
  ...SecretRedactor.entriesFromEnv(env),
  ...Object.entries(secrets).map(([label, value]) => ({ label, value })),
]

const gitCloneEnv = (envs: Record<string, string>) => {
  const token = envs.GIT_TOKEN
  return token === undefined ? {} : { GIT_TOKEN: token }
}

const originCloneScript = (project: Orb.ProjectRecord, envs: Record<string, string>) => {
  const base = ["git"]
  if (envs.GIT_TOKEN !== undefined) {
    base.push("-c", "credential.helper=!f() { echo username=x-access-token; echo password=$GIT_TOKEN; }; f")
  }
  base.push("clone", "--branch", project.default_branch, project.repo_origin, repoRoot)
  return base.map(shellQuote).join(" ")
}

const shellQuote = (value: string): string => {
  if (value.length === 0) return "''"
  if (/^[A-Za-z0-9_/@%+=:,.-]+$/.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}

const liveSystem: System = {
  makeTempPath: Effect.sync(() => join(tmpdir(), `rika-orb-${crypto.randomUUID()}.bundle`)),
  createGitBundle: ({ workspaceRoot, path }) =>
    Effect.tryPromise({
      try: async () => {
        const result = Bun.spawn(["git", "bundle", "create", path, "HEAD"], {
          cwd: workspaceRoot,
          stdout: "pipe",
          stderr: "pipe",
        })
        const [exitCode, stderr] = await Promise.all([result.exited, new Response(result.stderr).text()])
        if (exitCode !== 0) throw new Error(stderr)
        try {
          return new Uint8Array(await readFile(path))
        } finally {
          await rm(path, { force: true })
        }
      },
      catch: (cause) => new SystemError({ message: messageFromUnknown(cause), operation: "createGitBundle" }),
    }),
  currentBranch: (workspaceRoot) =>
    Effect.tryPromise({
      try: async () => {
        const result = Bun.spawn(["git", "branch", "--show-current"], {
          cwd: workspaceRoot,
          stdout: "pipe",
          stderr: "pipe",
        })
        const [exitCode, stdout, stderr] = await Promise.all([
          result.exited,
          new Response(result.stdout).text(),
          new Response(result.stderr).text(),
        ])
        if (exitCode !== 0) throw new Error(stderr)
        return stdout.trim()
      },
      catch: (cause) => new SystemError({ message: messageFromUnknown(cause), operation: "currentBranch" }),
    }),
  randomToken: Effect.sync(() => crypto.randomUUID().replaceAll("-", "")),
  health: (url, token) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${url.replace(/\/$/, "")}/health`, {
          headers: { authorization: `Bearer ${token}` },
        })
        if (!response.ok) throw new Error(`Health check failed with status ${response.status}`)
      },
      catch: (cause) => new SystemError({ message: messageFromUnknown(cause), operation: "health" }),
    }),
  sleep: (millis) => Effect.promise(() => Bun.sleep(millis)),
}

export const layer = layerWithSystem(liveSystem)

const messageFromUnknown = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string") {
    return cause.message
  }
  return String(cause)
}
