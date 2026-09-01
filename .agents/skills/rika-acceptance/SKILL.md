---
name: rika-acceptance
description: Packages and exercises real Rika Runner and Orb workflows. Use for packaged-product smoke tests, reconnect checks, continuation, cancellation, or release acceptance.
---

# Rika acceptance

Run acceptance through the packaged binary and the same hosted interfaces a user uses. Do not replace the API, model route, Runner, or E2B Executor with test doubles.

## Package preflight

From the repository root, run:

```bash
.agents/skills/rika-acceptance/scripts/with-packaged-rika.sh
```

The script selects the current supported host target, builds its archive, verifies the exact inventory from `scripts/packaging/package-contract.ts`, and runs `--version` and `--help` in a clean home. Pass arguments after `--` to launch the packaged binary after those checks:

```bash
.agents/skills/rika-acceptance/scripts/with-packaged-rika.sh -- --workspace "$PWD"
```

## Start the real development system

In an Amp orb, run `amp orb services ensure` and use the returned Portal. Elsewhere, run `bun run dev` in its own supervised terminal. Authenticate the packaged CLI against that development origin with `.agents/skills/rika-acceptance/scripts/with-packaged-rika.sh -- auth login --server <origin>` and the seeded development account. Do not expose or copy the seed password into logs or artifacts.

Use `testing-with-pilotty` for quick semantic snapshots or `testing-with-agent-tty` for a fixed-size recording. Start the packaged command through `with-packaged-rika.sh`, not `apps/rika/src/client-main.ts`. Use one unique run suffix for every file and completion marker.

## Runner flow

1. Launch `.agents/skills/rika-acceptance/scripts/with-packaged-rika.sh -- --workspace "$PWD"`. The initial Thread must become writable only after the Runner is connected and must never show `Preparing workspace`.
2. Submit a prompt that creates `.agents/state/<run>/runner-proof.txt`, reads it back, and ends with `RUNNER_DONE_<run>`. Verify the file directly from the checkout.
3. While that Turn is active, submit `CONTINUE_<run>` with Enter. Verify it appears as queued and later runs as its own Turn.
4. After both Turns settle, exit the TUI and reopen it with `.agents/skills/rika-acceptance/scripts/with-packaged-rika.sh -- thread continue <thread-id>`. Verify the transcript is contiguous without a manual refresh.
5. Ask Rika to run a foreground command that waits 20 seconds and then creates `.agents/state/<run>/forbidden`. Press Ctrl+C while it waits. After more than 20 seconds, use a fresh direct filesystem check to prove the file does not exist, then run one more prompt successfully in the same Thread.
6. Remove `.agents/state/<run>` after recording the assertions.

## Orb flow

1. In the same packaged TUI, choose `new in Orb` from the command palette. The Thread must remain unprepared until its first prompt.
2. Submit a prompt that creates and reads `orb-proof-<run>.txt`, starts a background process and inspects its completion, and ends with `ORB_DONE_<run>`. Keep `Preparing workspace` visible until the real E2B Executor is ready.
3. Start a foreground delayed write to `orb-forbidden-<run>`, cancel it with Ctrl+C, wait past the delay, and use a fresh Orb workspace read to prove the file is absent.
4. Run another workspace command in the same Thread. It must succeed without replacement preparation.
5. Terminate only the client, reopen with `.agents/skills/rika-acceptance/scripts/with-packaged-rika.sh -- thread continue <thread-id>`, and verify the transcript and terminal output remain contiguous.

## Evidence

Report the package-smoke result, development origin kind, Thread IDs, Runner checkout assertion, Orb-side file evidence, queue result, reconnect result, cancellation result, and any OpenRouter or E2B failure. Save reviewer-requested recordings under `.amp/in/artifacts/`. Do not claim full acceptance from a package smoke or screenshot alone.
