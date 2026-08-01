# Repository graph

The graph is structural only. Use dependency-cruiser for import parsing and the Bun-aware adapter for source-first workspace resolution. Do not add symbols, summaries, embeddings, semantic indexes, or ast-grep outlines. Generated JSON must be stable and fresh.

Example query: `bun --cwd tooling/repository-graph query -- check packages/product/src/operation/contract/product-operation.ts`; use its ranked tests, then query `impact`, `tests`, or `why` as needed.
