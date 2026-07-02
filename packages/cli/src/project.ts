import { Config } from "@rika/core"
import { Database, ProjectStore } from "@rika/persistence"
import { Ids, Orb } from "@rika/schema"
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as Args from "./args"
import * as Input from "./input"
import * as Output from "./output"

export class ProjectError extends Schema.TaggedErrorClass<ProjectError>()("ProjectError", {
  message: Schema.String,
  action: Args.ProjectAction,
}) {}

export type RunError = Database.DatabaseError | ProjectStore.ProjectStoreError | ProjectError

export interface Interface {
  readonly executeCommand: (command: Args.ProjectCommand) => Effect.Effect<number, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/Project") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const output = yield* Output.Service
    const input = yield* Input.Service
    const projects = yield* ProjectStore.Service
    const config = yield* Config.Service
    const values = yield* config.get

    return Service.of({
      executeCommand: Effect.fn("Cli.Project.executeCommand")(function* (command: Args.ProjectCommand) {
        switch (command.action) {
          case "create": {
            const project = yield* projects.create({
              name: yield* requireName(command),
              repo_origin: yield* repoOrigin(command, values.workspace_root),
              ...(command.default_branch === undefined ? {} : { default_branch: command.default_branch }),
              ...(command.template_id === undefined ? {} : { template_id: command.template_id }),
            })
            yield* output.stdout(formatJson(projectView(project)))
            return 0
          }
          case "list": {
            const records = yield* projects.list()
            yield* output.stdout(formatJson(records.map(projectView)))
            return 0
          }
          case "show": {
            const project = yield* requireProjectByName(projects, yield* requireName(command), command.action)
            yield* output.stdout(formatJson(projectView(project)))
            return 0
          }
          case "set-env": {
            const project = yield* requireProjectByName(projects, yield* requireName(command), command.action)
            const assignment = yield* parseAssignment(command)
            const updated = yield* projects.setEnv(project.project_id, assignment.key, assignment.value)
            yield* output.stdout(formatJson(projectView(updated)))
            return 0
          }
          case "set-secret": {
            const project = yield* requireProjectByName(projects, yield* requireName(command), command.action)
            const key = yield* requireSecretName(command)
            const value = trimTrailingNewline(yield* input.readAll)
            const updated = yield* projects.setSecret(project.project_id, key, value)
            yield* output.stdout(formatJson(projectView(updated)))
            return 0
          }
        }
        return yield* new ProjectError({ message: "Unsupported project action", action: command.action })
      }),
    })
  }),
)

export const executeCommand = Effect.fn("Cli.Project.executeCommand.call")(function* (command: Args.ProjectCommand) {
  const service = yield* Service
  return yield* service.executeCommand(command)
})

export const formatError = (error: RunError) => {
  if (error instanceof ProjectError) return error.message
  if (error instanceof Error) return `Rika failed: ${error.message}`
  return `Rika failed: ${String(error)}`
}

const requireName = (command: Args.ProjectCommand) =>
  command.name === undefined
    ? Effect.fail(
        new ProjectError({ message: `Project name is required for ${command.action}`, action: command.action }),
      )
    : Effect.succeed(command.name)

const repoOrigin = (command: Args.ProjectCommand, workspaceRoot: string) =>
  command.repo_origin === undefined
    ? currentGitRemoteOrigin(workspaceRoot, command.action)
    : Effect.succeed(command.repo_origin)

export const currentGitRemoteOrigin = (workspaceRoot: string, action: Args.ProjectAction = "create") =>
  Effect.tryPromise({
    try: async () => {
      const subprocess = Bun.spawn(["git", "config", "--get", "remote.origin.url"], {
        cwd: workspaceRoot,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        subprocess.exited,
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
      ])
      const value = stdout.trim()
      if (exitCode !== 0 || value.length === 0) throw new Error(stderr.trim() || "Workspace has no git remote origin")
      return value
    },
    catch: (cause) =>
      new ProjectError({
        message: cause instanceof Error ? cause.message : String(cause),
        action,
      }),
  })

export const resolveCurrentProjectId = Effect.fn("Cli.Project.resolveCurrentProjectId")(function* (
  workspaceRoot: string,
) {
  const projects = yield* ProjectStore.Service
  const origin = yield* currentGitRemoteOrigin(workspaceRoot).pipe(Effect.option)
  if (Option.isNone(origin)) return undefined
  const project = yield* projects.getByRepoOrigin(origin.value)
  return project?.project_id
}) satisfies (
  workspaceRoot: string,
) => Effect.Effect<
  Ids.ProjectId | undefined,
  Database.DatabaseError | ProjectStore.ProjectStoreError,
  ProjectStore.Service
>

const requireSecretName = (command: Args.ProjectCommand) =>
  command.secret_name === undefined
    ? Effect.fail(
        new ProjectError({ message: `Secret name is required for ${command.action}`, action: command.action }),
      )
    : Effect.succeed(command.secret_name)

const requireProjectByName = (projects: ProjectStore.Interface, name: string, action: Args.ProjectAction) =>
  projects
    .getByName(name)
    .pipe(
      Effect.flatMap((project) =>
        project === undefined
          ? Effect.fail(new ProjectError({ message: `Project ${name} not found`, action }))
          : Effect.succeed(project),
      ),
    )

const parseAssignment = (command: Args.ProjectCommand) =>
  (() => {
    const assignment = command.env_assignment ?? ""
    const separator = assignment.indexOf("=")
    return separator <= 0
      ? Effect.fail(new ProjectError({ message: "Expected KEY=VALUE", action: command.action }))
      : Effect.succeed({ key: assignment.slice(0, separator), value: assignment.slice(separator + 1) })
  })()

const projectView = (project: Orb.ProjectRecord) => ({
  project_id: project.project_id,
  name: project.name,
  repo_origin: project.repo_origin,
  default_branch: project.default_branch,
  template_id: project.template_id,
  env_keys: Object.keys(project.env).toSorted(),
  secret_names: project.secret_names,
  created_at: project.created_at,
  updated_at: project.updated_at,
})

const trimTrailingNewline = (value: string) => value.replace(/\r?\n$/, "")

const formatJson = (value: unknown) => JSON.stringify(value)
