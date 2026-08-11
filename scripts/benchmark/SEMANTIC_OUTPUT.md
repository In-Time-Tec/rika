# Semantic output benchmark

This benchmark exercises Baton's durable SQLite execution boundary with a custom `LanguageModel.make` stream. It compares published Baton 0.20.2 from a detached Rika v0.5.3 source identity with a complete local Baton 0.20.2 release inventory consumed from the current Rika source identity. It never uses `TestModel` parts as provider transport chunks.

Build the candidate release from the Baton candidate worktree:

```sh
rm -rf /tmp/baton-semantic-release
mkdir -p /tmp/baton-semantic-release
cd /Users/dallen.pyrah/projects/.worktrees/baton-repl-kernel
PACKAGE_ARTIFACT_DIR=/tmp/baton-semantic-release bun run package
```

Inspect the 24-run default plan without provisioning or executing:

```sh
cd /Users/dallen.pyrah/projects/.worktrees/rika-repl-kernel
bun run scripts/benchmark/semantic-output-benchmark.ts plan \
  --output /tmp/rika-semantic-output
```

Provision only. This verifies all 13 tarballs, `release-evidence.json`, `SHA256SUMS`, packed package identities, the detached v0.5.3 worktree, and isolated baseline/candidate installs:

```sh
bun run scripts/benchmark/semantic-output-benchmark.ts setup \
  --output /tmp/rika-semantic-output \
  --candidate-baton-release /tmp/baton-semantic-release
```

Run one warmup and three serial interleaved measurements for each source and shape:

```sh
bun run scripts/benchmark/semantic-output-benchmark.ts run \
  --output /tmp/rika-semantic-output \
  --candidate-baton-release /tmp/baton-semantic-release \
  --samples 3
```

The command writes raw samples, medians, identities, and the comparison to `/tmp/rika-semantic-output/semantic-output-result.json`. A failed gate still writes the report and exits nonzero. Each worker receives an isolated `HOME`, `TMPDIR`, working directory, Bun cache, Rika database path, and Baton database path under its run root; no default `~/.rika` path is used.

The three streams all carry exactly 1,000,000 ASCII `x` bytes: one delta, 10,000 100-byte deltas, and 10,000 alternating empty/200-byte deltas. The model uses fixed part IDs, finish reason, and usage and yields after every 32 fragments. The report includes output bytes/SHA-256, wall and CPU time, peak and post-full-GC heap, sampled process-tree peak and post-GC RSS, SQL event/tag/JSON/operation-result bytes, SQLite database/WAL/SHM/page/freelist/checkpoint evidence, first live response where the installed Runtime exposes it, and package/source identity.

## Limitations

- The automated owning interface is Baton-only. It does not claim Rika transcript, projection, or OpenTUI measurements; `commitProjectionCalls` is zero and excluded from a ratio gate when both sources are zero.
- Baseline first-response evidence is the first durable `ModelPart`; candidate evidence uses the disposable preview lane when that API exists. The report names which mechanism was observed, so they are not presented as identical signals.
- Process-tree RSS is sampled with `ps` at startup, after each 320 fragments, and after full GC. The one-fragment case has no mid-stream sample, shorter spikes can be missed, and the sampler itself has a small cost.
- `Bun.gc(true)` supports the recorded full-GC heap measurement. Bun exposes no portable allocator purge control, so allocator relief is explicitly reported as unsupported and remains informational.
- Provisioning published Baton 0.20.2 requires registry access and leaves the detached v0.5.3 worktree inside the chosen output directory. Removing the output may be followed by `git worktree prune`.
- Candidate numbers are valid only for the tarball digests in the recorded release evidence. A Git commit alone is not package identity, especially when the Baton candidate worktree contains uncommitted changes.
