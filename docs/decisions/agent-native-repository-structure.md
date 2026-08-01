# Agent-native repository structure

Each `src` tree has at most two semantic directory levels: `capability → subcapability`. Source modules use distinctive, semantic two-to-five-word kebab-case basenames. Package APIs expose finite exact export subpaths mapped to source modules, and adapters depend inward on product-owned contracts.

The structural thresholds remain 500 lines for the growth warning and 800 for the failure ceiling, four exported declarations for the warning and eight for the failure ceiling, and 12 direct dependencies for the warning and 18 for the failure ceiling. These limits keep ownership and change impact legible without forcing artificial splits.

The repository graph is a structural companion for imports, package edges, impact, tests, and why queries, not a semantic index. Bounded navigation evidence found owners quickly with few unnecessary reads and no policy violations, supporting these choices without changing the thresholds or adding semantic discovery infrastructure.
