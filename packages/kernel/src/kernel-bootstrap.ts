import { moduleNames } from "./binding/binding-modules"

/**
 * The bootstrap cell source.
 *
 * Baton's registry mounts each module as its own flat kernel global; assembling them into one
 * ergonomic `rika` object is product vocabulary, not framework concern, so it lives here. The kernel
 * evaluates this on every worker start AFTER snapshot restore and BEFORE the model's first cell,
 * matching Baton's restore-then-rebootstrap-then-notify order. It is never snapshot-restored, so
 * `rika` and `context` are always live bindings over the current worker.
 *
 * This source text is an input to `bindingsDigest`, so changing the surface changes the kernel
 * profile and starts a new epoch.
 */
/**
 * The bootstrap runs at worker start, outside any cell, so a host that answers binding requests
 * under the executing cell's identity has none to answer under and refuses this one. That refusal
 * is expected rather than exceptional: `context` describes the cell that is running, and at boot no
 * cell is. It is filled on the first cell that asks for it instead of failing the worker's start.
 */
export const source = (names: ReadonlyArray<string> = moduleNames): string => `
${names.map((name) => `globalThis[${JSON.stringify(name)}] = globalThis.kernel[${JSON.stringify(name)}]`).join("\n")}
globalThis.rika = { ${names.map((name) => `${name}: globalThis[${JSON.stringify(name)}]`).join(", ")} }
globalThis.rika.mcp = (() => {
  const flat = globalThis.rika.mcp
  const discovered = new Map()
  const notFound = (module, operation) => {
    const failure = { _tag: "McpBindingNotFound", module, message: operation === undefined
      ? "No MCP server named " + module + " is configured"
      : "Server " + module + " exposes no tool named " + operation }
    if (operation !== undefined) failure.operation = operation
    return failure
  }
  const serverProxy = (server) =>
    new Proxy({}, {
      get: (_target, tool) => {
        if (typeof tool !== "string") return undefined
        return async (input) => {
          if (!discovered.has(server)) {
            const tools = await flat.tools({ server })
            discovered.set(server, new Set(tools.map((entry) => entry.name).concat(tools.map((entry) => entry.rawName))))
          }
          if (!discovered.get(server).has(tool)) return notFound(server, tool)
          // A tool taking no argument is called with none, and JSON carries no undefined, so the
          // empty object it stands for is sent rather than a key that leaves the request.
          return flat.call({ server, tool, input: input === undefined ? {} : input })
        }
      },
    })
  return new Proxy(flat, {
    get: (target, property) => {
      if (property in target) return target[property]
      if (typeof property !== "string") return undefined
      return serverProxy(property)
    },
  })
})()
globalThis.context = await globalThis.rika.context.current({}).catch(() => undefined)
`

/** Every global the bootstrap defines. Nothing else may leak into the kernel namespace. */
export const globals: ReadonlyArray<string> = ["rika", "context"]
