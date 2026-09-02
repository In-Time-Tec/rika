import { Schema } from "effect"

interface ExecutionEnvironment {
  readonly values: Record<string, string>
  readonly replace: (values: Readonly<Record<string, string>>) => void
}

const environments = new WeakMap<Record<string, string>, (values: Readonly<Record<string, string>>) => void>()
const isString = Schema.is(Schema.String)

export const mutableExecutionEnvironment = (): ExecutionEnvironment => {
  let current = new Map<string, string>()
  const values = new Proxy<Record<string, string>>(
    {},
    {
      get: (_target, name) => (isString(name) ? current.get(name) : undefined),
      getOwnPropertyDescriptor: (_target, name) =>
        isString(name) && current.has(name)
          ? { configurable: true, enumerable: true, value: current.get(name), writable: false }
          : undefined,
      has: (_target, name) => isString(name) && current.has(name),
      ownKeys: () => [...current.keys()],
    },
  )
  const environment: ExecutionEnvironment = {
    values,
    replace: (next: Readonly<Record<string, string>>) => {
      current = new Map(Object.entries(next))
    },
  }
  environments.set(values, environment.replace)
  return environment
}

export const replaceExecutionEnvironment =
  (environment: Record<string, string>) =>
  (values: Readonly<Record<string, string>>): void => {
    environments.get(environment)?.(values)
  }
