# Repository tooling

Repository tooling owns structural policy, dependency graph generation, and deterministic queries. It may inspect workspace manifests and source imports but never `repos/*`, model-provider SDKs, or semantic code content. Generated graphs belong under `docs/generated/` and are written only by repository-graph generation.
