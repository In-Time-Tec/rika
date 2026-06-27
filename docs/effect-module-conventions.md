# Effect Module Conventions

Rika modules follow the same small, explicit shape throughout the monorepo so dependencies stay swappable and tests stay cheap.

## Package boundary exports

Package entrypoints export module namespaces instead of loose bags of names:

```ts
export * as ExampleService from "./example-service"
```

Callers import the namespace and reference its contract explicitly:

```ts
import { ExampleService } from "@rika/core"
```

## Service module skeleton

Each Effect service module uses this shape:

1. `export interface Interface` describes the public service methods.
2. `export class Service extends Context.Service<Service, Interface>()("@rika/package/ServiceName") {}` declares the tag.
3. Typed errors use `Schema.TaggedErrorClass` when the error crosses a service boundary.
4. `layer` or `defaultLayer` constructs the live implementation with `Layer.effect` or another explicit `Layer` constructor.
5. Tests provide fake or in-memory layers through the same `Service` tag.

Keep raw adapters behind service layers. Drizzle handles, Rivet clients, model SDKs, filesystem mutation, and subprocess access must not leak through an `Interface` unless that interface is intentionally an adapter boundary.

## Effect usage rules

- Use `Effect.fn("Module.method")` for service methods and named workflows.
- Bind services to named variables in generators before calling methods.
- Keep synchronous parsing and option building synchronous; only return `Effect` for effectful work.
- Keep layer construction close to the service it implements.
- Prefer fake/in-memory layers in tests over mocks of global state.

See `packages/core/src/example-service.ts` and `packages/core/src/example-service.test.ts` for the copyable baseline.
