import { mkdir, readFile, writeFile, chmod } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Config, IdGenerator, Time } from "@rika/core"
import { Common, Ids, Orb } from "@rika/schema"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { sql } from "drizzle-orm"
import * as Database from "./database"
import { projects } from "./schema"

export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}
export const CreateInput = Schema.Struct({
  name: Schema.String,
  repo_origin: Schema.String,
  default_branch: Schema.optional(Schema.String),
  template_id: Schema.optional(Schema.NullOr(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}).annotate({ identifier: "Rika.Persistence.ProjectStore.CreateInput" })

export interface UpdateInput extends Schema.Schema.Type<typeof UpdateInput> {}
export const UpdateInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  repo_origin: Schema.optional(Schema.String),
  default_branch: Schema.optional(Schema.String),
  template_id: Schema.optional(Schema.NullOr(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}).annotate({ identifier: "Rika.Persistence.ProjectStore.UpdateInput" })

const SecretValues = Schema.Record(Schema.String, Schema.String)

export class ProjectStoreError extends Schema.TaggedErrorClass<ProjectStoreError>()("ProjectStoreError", {
  message: Schema.String,
  operation: Schema.String,
  project_id: Schema.optional(Ids.ProjectId),
  name: Schema.optional(Schema.String),
}) {}

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Orb.ProjectRecord, Database.DatabaseError | ProjectStoreError>
  readonly get: (
    projectId: Ids.ProjectId,
  ) => Effect.Effect<Orb.ProjectRecord | undefined, Database.DatabaseError | ProjectStoreError>
  readonly getByName: (
    name: string,
  ) => Effect.Effect<Orb.ProjectRecord | undefined, Database.DatabaseError | ProjectStoreError>
  readonly getByRepoOrigin: (
    repoOrigin: string,
  ) => Effect.Effect<Orb.ProjectRecord | undefined, Database.DatabaseError | ProjectStoreError>
  readonly list: () => Effect.Effect<ReadonlyArray<Orb.ProjectRecord>, Database.DatabaseError | ProjectStoreError>
  readonly update: (
    projectId: Ids.ProjectId,
    input: UpdateInput,
  ) => Effect.Effect<Orb.ProjectRecord, Database.DatabaseError | ProjectStoreError>
  readonly setEnv: (
    projectId: Ids.ProjectId,
    key: string,
    value: string,
  ) => Effect.Effect<Orb.ProjectRecord, Database.DatabaseError | ProjectStoreError>
  readonly unsetEnv: (
    projectId: Ids.ProjectId,
    key: string,
  ) => Effect.Effect<Orb.ProjectRecord, Database.DatabaseError | ProjectStoreError>
  readonly setSecret: (
    projectId: Ids.ProjectId,
    key: string,
    value: string,
  ) => Effect.Effect<Orb.ProjectRecord, Database.DatabaseError | ProjectStoreError>
  readonly unsetSecret: (
    projectId: Ids.ProjectId,
    key: string,
  ) => Effect.Effect<Orb.ProjectRecord, Database.DatabaseError | ProjectStoreError>
  readonly secretsForProvision: (
    projectId: Ids.ProjectId,
  ) => Effect.Effect<Record<string, string>, Database.DatabaseError | ProjectStoreError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/persistence/ProjectStore") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const databaseService = yield* Database.Service
    const idGenerator = yield* IdGenerator.Service
    const time = yield* Time.Service
    const config = yield* Config.Service
    const values = yield* config.get
    const secretsDirectory = join(values.data_dir, "secrets")
    return Service.of({
      create: Effect.fn("ProjectStore.create")(function* (input: CreateInput) {
        const projectId = Ids.ProjectId.make(yield* idGenerator.next("project"))
        const now = yield* time.nowMillis
        const project: Orb.ProjectRecord = {
          project_id: projectId,
          name: input.name,
          repo_origin: input.repo_origin,
          default_branch: input.default_branch ?? "main",
          template_id: input.template_id ?? null,
          env: input.env ?? {},
          secret_names: [],
          created_at: now,
          updated_at: now,
        }
        return yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () => {
              database.insert(projects).values(projectToRow(project)).run()
              return project
            },
            catch: (cause) => toError(cause, "create", projectId, input.name),
          }),
        )
      }),
      get: Effect.fn("ProjectStore.get")(function* (projectId: Ids.ProjectId) {
        const project = yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () =>
              rowToProject(
                database.get<ProjectRow>(sql`select * from projects where project_id = ${projectId} limit 1`),
              ),
            catch: (cause) => toError(cause, "get", projectId),
          }),
        )
        return project === undefined ? undefined : yield* withSecretNames(project, secretsDirectory)
      }),
      getByName: Effect.fn("ProjectStore.getByName")(function* (name: string) {
        const project = yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () => rowToProject(database.get<ProjectRow>(sql`select * from projects where name = ${name} limit 1`)),
            catch: (cause) => toError(cause, "getByName", undefined, name),
          }),
        )
        return project === undefined ? undefined : yield* withSecretNames(project, secretsDirectory)
      }),
      getByRepoOrigin: Effect.fn("ProjectStore.getByRepoOrigin")(function* (repoOrigin: string) {
        const project = yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () =>
              rowToProject(
                database.get<ProjectRow>(
                  sql`select * from projects where repo_origin = ${repoOrigin} order by name asc limit 1`,
                ),
              ),
            catch: (cause) => toError(cause, "getByRepoOrigin"),
          }),
        )
        return project === undefined ? undefined : yield* withSecretNames(project, secretsDirectory)
      }),
      list: Effect.fn("ProjectStore.list")(function* () {
        const records = yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () =>
              database.all<ProjectRow>(sql`select * from projects order by name asc`).flatMap((row) => {
                const project = rowToProject(row)
                return project === undefined ? [] : [project]
              }),
            catch: (cause) => toError(cause, "list"),
          }),
        )
        return yield* Effect.forEach(records, (project) => withSecretNames(project, secretsDirectory))
      }),
      update: Effect.fn("ProjectStore.update")(function* (projectId: Ids.ProjectId, input: UpdateInput) {
        const now = yield* time.nowMillis
        const updated = yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () => updateProject(database, projectId, now, input),
            catch: (cause) => toError(cause, "update", projectId),
          }),
        )
        return yield* withSecretNames(updated, secretsDirectory)
      }),
      setEnv: Effect.fn("ProjectStore.setEnv")(function* (projectId: Ids.ProjectId, key: string, value: string) {
        const now = yield* time.nowMillis
        const updated = yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () => updateEnv(database, projectId, now, (env) => ({ ...env, [key]: value })),
            catch: (cause) => toError(cause, "setEnv", projectId),
          }),
        )
        return yield* withSecretNames(updated, secretsDirectory)
      }),
      unsetEnv: Effect.fn("ProjectStore.unsetEnv")(function* (projectId: Ids.ProjectId, key: string) {
        const now = yield* time.nowMillis
        const updated = yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () =>
              updateEnv(database, projectId, now, (env) => {
                const next = { ...env }
                delete next[key]
                return next
              }),
            catch: (cause) => toError(cause, "unsetEnv", projectId),
          }),
        )
        return yield* withSecretNames(updated, secretsDirectory)
      }),
      setSecret: Effect.fn("ProjectStore.setSecret")(function* (projectId: Ids.ProjectId, key: string, value: string) {
        const now = yield* time.nowMillis
        const project = yield* requireProject(databaseService, projectId, "setSecret")
        const path = secretFile(secretsDirectory, projectId)
        const existing = yield* readSecrets(path, projectId)
        const next = { ...existing, [key]: value }
        yield* writeSecrets(path, next, projectId)
        yield* touchProject(databaseService, projectId, now, "setSecret")
        return { ...project, secret_names: secretNames(next), updated_at: now }
      }),
      unsetSecret: Effect.fn("ProjectStore.unsetSecret")(function* (projectId: Ids.ProjectId, key: string) {
        const now = yield* time.nowMillis
        const project = yield* requireProject(databaseService, projectId, "unsetSecret")
        const path = secretFile(secretsDirectory, projectId)
        const existing = yield* readSecrets(path, projectId)
        const next = { ...existing }
        delete next[key]
        yield* writeSecrets(path, next, projectId)
        yield* touchProject(databaseService, projectId, now, "unsetSecret")
        return { ...project, secret_names: secretNames(next), updated_at: now }
      }),
      secretsForProvision: Effect.fn("ProjectStore.secretsForProvision")(function* (projectId: Ids.ProjectId) {
        yield* requireProject(databaseService, projectId, "secretsForProvision")
        return yield* readSecrets(secretFile(secretsDirectory, projectId), projectId)
      }),
    })
  }),
)

export const create = Effect.fn("ProjectStore.create.call")(function* (input: CreateInput) {
  const store = yield* Service
  return yield* store.create(input)
})

export const get = Effect.fn("ProjectStore.get.call")(function* (projectId: Ids.ProjectId) {
  const store = yield* Service
  return yield* store.get(projectId)
})

export const getByName = Effect.fn("ProjectStore.getByName.call")(function* (name: string) {
  const store = yield* Service
  return yield* store.getByName(name)
})

export const getByRepoOrigin = Effect.fn("ProjectStore.getByRepoOrigin.call")(function* (repoOrigin: string) {
  const store = yield* Service
  return yield* store.getByRepoOrigin(repoOrigin)
})

export const list = Effect.fn("ProjectStore.list.call")(function* () {
  const store = yield* Service
  return yield* store.list()
})

export const update = Effect.fn("ProjectStore.update.call")(function* (projectId: Ids.ProjectId, input: UpdateInput) {
  const store = yield* Service
  return yield* store.update(projectId, input)
})

export const setEnv = Effect.fn("ProjectStore.setEnv.call")(function* (
  projectId: Ids.ProjectId,
  key: string,
  value: string,
) {
  const store = yield* Service
  return yield* store.setEnv(projectId, key, value)
})

export const unsetEnv = Effect.fn("ProjectStore.unsetEnv.call")(function* (projectId: Ids.ProjectId, key: string) {
  const store = yield* Service
  return yield* store.unsetEnv(projectId, key)
})

export const setSecret = Effect.fn("ProjectStore.setSecret.call")(function* (
  projectId: Ids.ProjectId,
  key: string,
  value: string,
) {
  const store = yield* Service
  return yield* store.setSecret(projectId, key, value)
})

export const unsetSecret = Effect.fn("ProjectStore.unsetSecret.call")(function* (
  projectId: Ids.ProjectId,
  key: string,
) {
  const store = yield* Service
  return yield* store.unsetSecret(projectId, key)
})

export const secretsForProvision = Effect.fn("ProjectStore.secretsForProvision.call")(function* (
  projectId: Ids.ProjectId,
) {
  const store = yield* Service
  return yield* store.secretsForProvision(projectId)
})

interface ProjectRow {
  readonly project_id: string
  readonly name: string
  readonly repo_origin: string
  readonly default_branch: string
  readonly template_id: string | null
  readonly env: string
  readonly created_at: number
  readonly updated_at: number
}

const projectToRow = (project: Orb.ProjectRecord) => ({
  project_id: project.project_id,
  name: project.name,
  repo_origin: project.repo_origin,
  default_branch: project.default_branch,
  template_id: project.template_id,
  env: JSON.stringify(project.env),
  created_at: project.created_at,
  updated_at: project.updated_at,
})

const rowToProject = (row: ProjectRow | undefined): Orb.ProjectRecord | undefined => {
  if (row === undefined) return undefined
  const env = decodeEnv(row.env)
  if (Option.isNone(env)) return undefined
  return {
    project_id: Ids.ProjectId.make(row.project_id),
    name: row.name,
    repo_origin: row.repo_origin,
    default_branch: row.default_branch,
    template_id: row.template_id,
    env: env.value,
    secret_names: [],
    created_at: Common.TimestampMillis.make(row.created_at),
    updated_at: Common.TimestampMillis.make(row.updated_at),
  }
}

const updateEnv = (
  database: Pick<Database.DrizzleDatabase, "get" | "run">,
  projectId: Ids.ProjectId,
  updatedAt: Common.TimestampMillis,
  transformEnv: (env: Record<string, string>) => Record<string, string>,
) => {
  const existing = rowToProject(
    database.get<ProjectRow>(sql`select * from projects where project_id = ${projectId} limit 1`),
  )
  if (existing === undefined) {
    throw new ProjectStoreError({
      message: `Project ${projectId} not found`,
      operation: "updateEnv",
      project_id: projectId,
    })
  }
  const next: Orb.ProjectRecord = { ...existing, env: transformEnv(existing.env), updated_at: updatedAt }
  database.run(
    sql`update projects set env = ${JSON.stringify(next.env)}, updated_at = ${updatedAt} where project_id = ${projectId}`,
  )
  return next
}

const updateProject = (
  database: Pick<Database.DrizzleDatabase, "get" | "run">,
  projectId: Ids.ProjectId,
  updatedAt: Common.TimestampMillis,
  input: UpdateInput,
) => {
  const existing = rowToProject(
    database.get<ProjectRow>(sql`select * from projects where project_id = ${projectId} limit 1`),
  )
  if (existing === undefined) {
    throw new ProjectStoreError({
      message: `Project ${projectId} not found`,
      operation: "updateProject",
      project_id: projectId,
    })
  }
  const next: Orb.ProjectRecord = {
    ...existing,
    name: input.name ?? existing.name,
    repo_origin: input.repo_origin ?? existing.repo_origin,
    default_branch: input.default_branch ?? existing.default_branch,
    template_id: input.template_id === undefined ? existing.template_id : input.template_id,
    env: input.env ?? existing.env,
    updated_at: updatedAt,
  }
  database.run(
    sql`update projects set
      name = ${next.name},
      repo_origin = ${next.repo_origin},
      default_branch = ${next.default_branch},
      template_id = ${next.template_id},
      env = ${JSON.stringify(next.env)},
      updated_at = ${updatedAt}
      where project_id = ${projectId}`,
  )
  return next
}

const requireProject = (
  databaseService: Database.Interface,
  projectId: Ids.ProjectId,
  operation: string,
): Effect.Effect<Orb.ProjectRecord, Database.DatabaseError | ProjectStoreError> =>
  databaseService.withDatabaseEffect((database) =>
    Effect.try({
      try: () => {
        const project = rowToProject(
          database.get<ProjectRow>(sql`select * from projects where project_id = ${projectId} limit 1`),
        )
        if (project === undefined) {
          throw new ProjectStoreError({ message: `Project ${projectId} not found`, operation, project_id: projectId })
        }
        return project
      },
      catch: (cause) => toError(cause, operation, projectId),
    }),
  )

const touchProject = (
  databaseService: Database.Interface,
  projectId: Ids.ProjectId,
  updatedAt: Common.TimestampMillis,
  operation: string,
) =>
  databaseService.withDatabaseEffect((database) =>
    Effect.try({
      try: () => database.run(sql`update projects set updated_at = ${updatedAt} where project_id = ${projectId}`),
      catch: (cause) => toError(cause, operation, projectId),
    }),
  )

const withSecretNames = (project: Orb.ProjectRecord, secretsDirectory: string) =>
  readSecrets(secretFile(secretsDirectory, project.project_id), project.project_id).pipe(
    Effect.map((secrets) => ({ ...project, secret_names: secretNames(secrets) })),
  )

const secretFile = (secretsDirectory: string, projectId: Ids.ProjectId) => join(secretsDirectory, `${projectId}.json`)

const secretNames = (values: Record<string, string>) => Object.keys(values).toSorted()

const readSecrets = (path: string, projectId: Ids.ProjectId) =>
  Effect.tryPromise({
    try: async () => {
      let text: string
      try {
        text = await readFile(path, "utf8")
      } catch (cause) {
        if (isNotFound(cause)) return {}
        throw cause
      }
      const parsed = JSON.parse(text) as unknown
      const decoded = Schema.decodeUnknownOption(SecretValues)(parsed)
      if (Option.isNone(decoded)) {
        throw new ProjectStoreError({
          message: `Invalid project secrets file for ${projectId}`,
          operation: "readSecrets",
          project_id: projectId,
        })
      }
      return decoded.value
    },
    catch: (cause) => toError(cause, "readSecrets", projectId),
  })

const writeSecrets = (path: string, values: Record<string, string>, projectId: Ids.ProjectId) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 })
      await chmod(path, 0o600)
    },
    catch: (cause) => toError(cause, "writeSecrets", projectId),
  })

const isNotFound = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  typeof cause.code === "string" &&
  cause.code === "ENOENT"

const decodeEnv = (value: string) => {
  const parsed = parseJson(value)
  if (Option.isNone(parsed)) return Option.none<Record<string, string>>()
  return Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.String))(parsed.value)
}

const parseJson = (value: string): Option.Option<unknown> => {
  try {
    return Option.some(JSON.parse(value))
  } catch {
    return Option.none()
  }
}

const toError = (cause: unknown, operation: string, projectId?: Ids.ProjectId, name?: string) => {
  if (cause instanceof ProjectStoreError) return cause
  return new ProjectStoreError({
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
    ...(projectId === undefined ? {} : { project_id: projectId }),
    ...(name === undefined ? {} : { name }),
  })
}
