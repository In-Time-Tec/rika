import type { OpencodeClient, Session } from "@opencode-ai/sdk/v2/client"
import { Effect } from "effect"
import { RikaAdapterError, type RikaAdapter, type RikaDirectoryRuntime } from "./adapter"
import type { CompatibleApi } from "@/utils/server-compat"

export type LegacyClient = OpencodeClient
export type RuntimePromise = Promise<RikaDirectoryRuntime>
type AnyFunction = (...args: ReadonlyArray<unknown>) => unknown

const unavailable = (path: string): AnyFunction =>
  new Proxy(
    (..._args: ReadonlyArray<unknown>) =>
      Promise.reject(
        RikaAdapterError.make({
          operation: path,
          message: `${path} is not available in the Rika desktop`,
        }),
      ),
    {
      get: (_target, property) => {
        if (property === "then") return undefined
        return unavailable(`${path}.${String(property)}`)
      },
    },
  )

const facade = <A extends object>(value: A, path: string): A =>
  new Proxy(value, {
    get: (target, property, receiver) => {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver)
      return unavailable(`${path}.${String(property)}`)
    },
  })

const response = () => new Response(null, { status: 200 })
const legacyResult = <A>(data: A) => Promise.resolve({ data, response: response() })

const requireThread = async (runtime: RikaDirectoryRuntime, sessionID: string): Promise<Session> => {
  const cached = runtime.getThread(sessionID)
  if (cached) return cached
  await Effect.runPromise(runtime.selectThread(sessionID))
  const selected = runtime.getThread(sessionID)
  if (selected) return selected
  throw RikaAdapterError.make({ operation: "Session.get", message: `Thread ${sessionID} is unavailable` })
}

const providerCatalog = async (adapter: Promise<RikaAdapter>, workspace = "") => {
  const catalog = await adapter.then((value) => Effect.runPromise(value.catalog(workspace)))
  const providerID = catalog.model.route.providerId
  const modelID = catalog.model.route.model
  if (providerID !== "openrouter")
    throw RikaAdapterError.make({
      operation: "Provider.catalog",
      message: "Rika desktop supports OpenRouter only",
    })
  if (modelID !== "openrouter/free" && !modelID.endsWith(":free"))
    throw RikaAdapterError.make({
      operation: "Provider.catalog",
      message: `Rika desktop supports OpenRouter free models only, not ${modelID}`,
    })
  const providerSettings = catalog.settings.providers.openrouter ?? {}
  const provider = {
    id: providerID,
    name: "OpenRouter",
    source: "api",
    env: [],
    options: providerSettings,
    settings: providerSettings,
  }
  const model = {
    id: modelID,
    providerID,
    modelID,
    name: modelID,
    family: providerID,
    capabilities: { input: ["text", "image"], output: ["text"], tools: true },
    cost: [],
    limit: { context: 0, output: 0 },
    status: "active",
    settings: {},
    headers: {},
    time: { released: 0 },
    variants: [],
  }
  const legacyModel = {
    id: modelID,
    providerID,
    api: {
      id: modelID,
      url:
        typeof providerSettings === "object" && providerSettings !== null && "baseUrl" in providerSettings
          ? String(providerSettings.baseUrl)
          : "",
      npm: providerID,
    },
    name: modelID,
    family: providerID,
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 0, output: 0 },
    status: "active",
    options: {},
    headers: {},
    release_date: new Date(0).toISOString().slice(0, 10),
    variants: {},
  }
  return {
    catalog,
    provider: { ...provider, models: { [modelID]: legacyModel } },
    model,
    connected: catalog.environment.providerApiKeys[providerID] === "present",
  }
}

const configuration = async (adapter: Promise<RikaAdapter>, workspace = "") => {
  const value = await providerCatalog(adapter, workspace)
  return {
    provider: { [value.provider.id]: value.provider.settings },
    enabled_providers: [value.provider.id],
    disabled_providers: [],
    model: `${value.provider.id}/${value.model.id}`,
  }
}

export const createLegacyFacade = (adapter: Promise<RikaAdapter>, runtimePromise?: RuntimePromise): LegacyClient => {
  const runtime = () => {
    if (runtimePromise) return runtimePromise
    return Promise.reject(
      RikaAdapterError.make({ operation: "Directory", message: "A workspace is required for this operation" }),
    )
  }
  const catalog = async () => providerCatalog(adapter, runtimePromise ? (await runtime()).workspace : "")
  const config = async () => configuration(adapter, runtimePromise ? (await runtime()).workspace : "")
  const runtimeFor = (threadId: string) =>
    runtimePromise ?? adapter.then((value) => Effect.runPromise(value.runtimeForThread(threadId)))
  const allThreads = () =>
    runtimePromise
      ? runtimePromise.then((value) => Effect.runPromise(value.listThreads()))
      : adapter.then((value) => Effect.runPromise(value.listThreads))
  const actual = {
    global: facade(
      {
        config: facade({ get: async () => legacyResult(await config()) }, "global.config"),
        dispose: async () => adapter.then((value) => Effect.runPromise(value.catalog())),
      },
      "global",
    ),
    config: facade({ get: async () => legacyResult(await config()) }, "config"),
    session: facade(
      {
        list: async (input?: { roots?: boolean; limit?: number }) => {
          if (runtimePromise) {
            const value = await runtime()
            return legacyResult(await Effect.runPromise(value.listThreads({ limit: input?.limit })))
          }
          return legacyResult((await allThreads()).slice(0, input?.limit))
        },
        get: async (input: { sessionID: string }) =>
          legacyResult(await requireThread(await runtimeFor(input.sessionID), input.sessionID)),
        messages: async (input: { sessionID: string }) =>
          legacyResult((await runtimeFor(input.sessionID)).getMessages(input.sessionID)),
        message: async (input: { sessionID: string; messageID: string }) => {
          const messages = (await runtimeFor(input.sessionID)).getMessages(input.sessionID)
          const value = messages.find((message) => message.info.id === input.messageID)
          if (!value)
            throw RikaAdapterError.make({
              operation: "Session.message",
              message: `Message ${input.messageID} is unavailable`,
            })
          return legacyResult(value)
        },
        status: async () => {
          const sessions = await allThreads()
          const entries = await Promise.all(
            sessions.map(async (session) => {
              const value = await runtimeFor(session.id)
              return [session.id, value.getStatus(session.id) ?? { type: "idle" }] as const
            }),
          )
          return legacyResult(Object.fromEntries(entries))
        },
        update: async (input: { sessionID: string; time?: { archived?: number } }) => {
          const value = await runtimeFor(input.sessionID)
          if (input.time && "archived" in input.time)
            await Effect.runPromise(
              value.archive({ threadId: input.sessionID, archived: input.time.archived !== undefined }),
            )
          return legacyResult(await requireThread(value, input.sessionID))
        },
      },
      "session",
    ),
    permission: facade(
      {
        list: async () => legacyResult((await runtime()).getPermissions()),
      },
      "permission",
    ),
    path: facade(
      {
        get: async () => {
          const directory = runtimePromise ? (await runtime()).workspace : ""
          return legacyResult({ state: "", config: "", worktree: directory, directory, home: directory })
        },
      },
      "path",
    ),
    auth: facade(
      {
        set: async (input: { providerID: string; auth: { type: string; key?: string } }) => {
          if (input.providerID !== "openrouter" || input.auth.type !== "api" || !input.auth.key)
            throw RikaAdapterError.make({
              operation: "Auth.login",
              message: "Rika desktop supports OpenRouter API keys only",
            })
          return adapter.then((value) =>
            Effect.runPromise(value.login({ provider: "openrouter", apiKey: input.auth.key! })),
          )
        },
        remove: async (input: { providerID: string }) => {
          if (input.providerID !== "openrouter")
            throw RikaAdapterError.make({ operation: "Auth.logout", message: "Rika desktop supports OpenRouter only" })
          return adapter.then((value) => Effect.runPromise(value.logout("openrouter")))
        },
      },
      "auth",
    ),
    provider: facade(
      {
        auth: async () =>
          legacyResult({ openrouter: [{ type: "api", label: "API key" }] }),
        list: async () => {
          const value = await catalog()
          return legacyResult({
            all: [value.provider],
            connected: value.connected ? [value.provider.id] : [],
            default: { [value.provider.id]: value.model.id },
          })
        },
      },
      "provider",
    ),
    app: facade(
      {
        agents: async () =>
          legacyResult([
            {
              name: "rika",
              description: "Rika",
              mode: "primary",
              hidden: false,
              permission: [],
              options: {},
              steps: 100,
            },
          ]),
      },
      "app",
    ),
    command: facade({ list: async () => legacyResult([]) }, "command"),

  }
  return facade(actual, "rika") as unknown as LegacyClient
}

const turnFromMessage = (messageID: string | undefined) => {
  if (!messageID?.startsWith("rika-message:")) return undefined
  const encoded = messageID.slice("rika-message:".length).replace(/:(?:0|1)$/, "")
  try {
    return decodeURIComponent(encoded)
  } catch {
    return undefined
  }
}

export const createApiFacade = (adapter: Promise<RikaAdapter>, runtimePromise?: RuntimePromise): CompatibleApi => {
  const runtime = () => {
    if (runtimePromise) return runtimePromise
    return Promise.reject(
      RikaAdapterError.make({ operation: "Directory", message: "A workspace is required for this operation" }),
    )
  }
  const runtimeAt = (directory?: string) =>
    directory
      ? adapter.then((value) => Effect.runPromise(value.directory(directory)))
      : runtime()
  const catalog = async (directory?: string) =>
    providerCatalog(adapter, directory ?? (runtimePromise ? (await runtime()).workspace : ""))
  const runtimeFor = (threadId: string) =>
    runtimePromise ?? adapter.then((value) => Effect.runPromise(value.runtimeForThread(threadId)))
  const runtimeForAuthorization = (requestId: string) =>
    runtimePromise ?? adapter.then((value) => Effect.runPromise(value.runtimeForAuthorization(requestId)))
  const actual = {
    session: facade(
      {
        list: async (input?: { search?: string; limit?: number; location?: { directory?: string } }) => ({
          data: await (runtimePromise
            ? Effect.runPromise((await runtime()).listThreads({ search: input?.search, limit: input?.limit }))
            : input?.location?.directory
              ? runtimeAt(input.location.directory).then((value) =>
                  Effect.runPromise(value.listThreads({ search: input.search, limit: input.limit })),
                )
              : adapter.then((value) =>
                Effect.runPromise(
                  value.listThreads.pipe(
                    Effect.map((sessions) =>
                      input?.search
                        ? sessions.filter((session) =>
                            `${session.title ?? ""} ${session.directory}`
                              .toLocaleLowerCase()
                              .includes(input.search!.toLocaleLowerCase()),
                          )
                        : sessions,
                    ),
                  ),
                ),
              )),
          cursor: {},
        }),
        active: async () => [],
        get: async (input: { sessionID: string }) => requireThread(await runtimeFor(input.sessionID), input.sessionID),
        create: async (input: { location?: { directory?: string } }) => {
          const directory = input.location?.directory
          const value = directory
            ? await adapter.then((item) => Effect.runPromise(item.directory(directory)))
            : await runtime()
          return Effect.runPromise(value.createThread)
        },
        prompt: async (input: { sessionID: string; id?: string; text: string }) =>
          Effect.runPromise(
            (await runtimeFor(input.sessionID)).submit({
              threadId: input.sessionID,
              prompt: input.text,
              submissionId: input.id,
            }),
          ),
        shell: async (input: { sessionID: string; command: string }) =>
          Effect.runPromise(
            (await runtimeFor(input.sessionID)).shell({
              threadId: input.sessionID,
              command: input.command,
              incognito: false,
            }),
          ),
        interrupt: async (input: { sessionID: string }) =>
          Effect.runPromise((await runtimeFor(input.sessionID)).cancel(input.sessionID)),
        rename: async (input: { sessionID: string; title: string }) =>
          Effect.runPromise(
            (await runtimeFor(input.sessionID)).rename({ threadId: input.sessionID, title: input.title }),
          ),
        remove: async (input: { sessionID: string }) =>
          Effect.runPromise((await runtimeFor(input.sessionID)).delete(input.sessionID)),
        fork: async (input: { sessionID: string; messageID?: string }) =>
          Effect.runPromise(
            (await runtimeFor(input.sessionID)).fork({
              threadId: input.sessionID,
              atTurn: turnFromMessage(input.messageID),
            }),
          ),
      },
      "session",
    ),
    message: facade(
      {
        list: async (input: { sessionID: string }) => ({
          data: (await runtimeFor(input.sessionID)).getMessages(input.sessionID),
          cursor: {},
        }),
      },
      "message",
    ),
    permission: facade(
      {
        request: facade(
          {
            list: async (input?: { location?: { directory?: string } }) => ({
              data: (await runtimeAt(input?.location?.directory)).getPermissions(),
            }),
          },
          "permission.request",
        ),
        reply: async (input: { requestID: string; reply: "once" | "reject" | "always" }) => {
          if (input.reply === "always")
            throw RikaAdapterError.make({
              operation: "Authorization.reply",
              message: "Rika supports one-time approval or denial only",
            })
          return Effect.runPromise(
            (await runtimeForAuthorization(input.requestID)).replyAuthorization({
              requestId: input.requestID,
              reply: input.reply,
            }),
          )
        },
      },
      "permission",
    ),
    agent: facade(
      {
        list: async () => ({
          data: [
            {
              name: "rika",
              description: "Rika",
              mode: "primary",
              hidden: false,
              permission: [],
              options: {},
              steps: 100,
            },
          ],
        }),
      },
      "agent",
    ),
    command: facade({ list: async () => ({ data: [] }) }, "command"),
    reference: facade({ list: async () => ({ data: [] }) }, "reference"),
    project: facade(
      {
        current: async (input?: { location?: { directory?: string } }) => {
          const directory = input?.location?.directory
          const workspace = directory
            ? (await adapter.then((value) => Effect.runPromise(value.directory(directory)))).workspace
            : (await runtime()).workspace
          return { id: workspace, worktree: workspace, name: workspace, sandboxes: [] }
        },
        list: async () => {
          if (!runtimePromise) return []
          const directory = (await runtime()).workspace
          return [{ id: directory, worktree: directory, name: directory, sandboxes: [] }]
        },
      },
      "project",
    ),
    integration: facade(
      {
        get: async (input: { integrationID: string; location?: unknown }) => {
          if (input.integrationID !== "openrouter")
            throw RikaAdapterError.make({
              operation: "Integration.get",
              message: "Rika desktop supports OpenRouter only",
            })
          return {
            id: "openrouter",
            name: "OpenRouter",
            methods: [{ type: "key" as const, label: "API key" }],
            connections: [],
            ...(input.location === undefined ? {} : { location: input.location }),
          }
        },
        connect: facade(
          {
            key: async (input: { integrationID: string; key: string }) => {
              if (input.integrationID !== "openrouter")
                throw RikaAdapterError.make({
                  operation: "Auth.login",
                  message: "Rika desktop supports OpenRouter API keys only",
                })
              return adapter.then((value) =>
                Effect.runPromise(value.login({ provider: "openrouter", apiKey: input.key })),
              )
            },
          },
          "integration.connect",
        ),
      },
      "integration",
    ),
    provider: facade(
      {
        list: async (input?: { location?: { directory?: string } }) => ({
          data: [(await catalog(input?.location?.directory)).provider],
        }),
      },
      "provider",
    ),
    model: facade(
      {
        list: async (input?: { location?: { directory?: string } }) => ({
          data: [(await catalog(input?.location?.directory)).model],
        }),
        default: async (input?: { location?: { directory?: string } }) => {
          const value = await catalog(input?.location?.directory)
          return { data: { providerID: value.provider.id, id: value.model.id } }
        },
      },
      "model",
    ),
  }
  return facade(actual, "rika") as unknown as CompatibleApi
}
