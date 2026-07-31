# Structural dependency graph source

Slice 1 uses dependency-cruiser 18.1.0 with its TypeScript parser to enumerate import syntax. The compatibility fixture proves TypeScript 7 Bundler syntax, Effect syntax, prompt assets, and unit-test imports are parsed. Its native resolver cannot resolve Bun source-first workspace exports or external Effect packages: those edges are reported unknown even when Bun resolves them.

The repository-graph adapter therefore owns deterministic structural resolution. Relative imports use source and prompt-asset extensions. Workspace package names and exact export subpaths resolve from workspace manifests. Third-party packages become external package nodes and are not traversed. Unknown internal subpaths, missing relative targets, ambiguous exports, and unclassified assets are violations. This fallback preserves structural import edges without symbols, summaries, or a semantic index.

The four committed artifacts use schemaVersion 1 and stable sorted JSON. Freshness checks generate into a temporary directory and compare bytes without repairing checked-in output.
