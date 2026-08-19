# Effect module conventions

Effect services and schemas belong to the module that owns their domain contract. Process entrypoints are the only modules that run Effects. Pure checks, graph projections, path resolution, and query functions remain deterministic and do not run an Effect.

Adapters keep host APIs at named boundaries, use typed failures, and preserve interruption and scope ownership. Cross-package imports use exact manifest exports. Tests use colocated unit files and dedicated TUI or process projects for interactive and lifecycle behavior.
