# E2B Orb acceptance evidence

Date: 2026-08-31

This report combines the scrubbed outputs from two disposable, secret-backed Amp orbs:

- constrained-network and real-Orb verifier:
  `https://ampcode.com/threads/T-01a05638-f1bb-76cb-995d-cbaa1415bb48`;
- fresh-secret verifier:
  `https://ampcode.com/threads/T-01a05685-9bf7-711b-b226-dabb4da941d2`.

No key, authorization value, or provider response header containing a credential is retained.

## Constrained-network reproduction

The failing sandbox used the same material network options as Rika's controller:

```text
secure: true
allowInternetAccess: true
allowPublicTraffic: false
lifecycle: pause on timeout, no automatic resume
allowOut: [Rika API hostname]
denyOut: [0.0.0.0/0]
```

There was no stored setup-egress row, so only Rika's API hostname was allowed.

- HTTPS to `registry.npmjs.org` and another disallowed host sent a TLS ClientHello, then ended
  with `SSL_ERROR_SYSCALL`/unexpected EOF.
- `bun add --no-save is-odd@1.0.0` reproduced
  `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR downloading package manifest is-odd` on 3/3 attempts
  in a fresh constrained sandbox.
- Pointing `SSL_CERT_FILE` or `NODE_EXTRA_CA_CERTS` at the system or E2B CA bundle did not change
  the result. The failure was egress denial, not a missing trust store.
- Some exploratory shell pipelines masked Bun's exit status; those wrapper exit codes are not
  treated as passing evidence.

With only `registry.npmjs.org` added to `allowOut`, while retaining the all-traffic deny baseline:

- curl validated the npm certificate (`Google Trust Services / WE1`);
- `bun add is-odd` succeeded in 399 ms and then 3 ms from its local cache;
- a fresh-cache `bun install --frozen-lockfile` installed 664 packages in 8.11 seconds.

This proves that the missing registry destination was a deterministic policy defect and is the
evidence for the narrow absent-policy setup defaults. It does not prove that E2B's hostname
filter is reliable across repeated sandboxes. The source permits `github.com` and
`registry.npmjs.org` during setup; runtime still has no default public destination, and any
stored phase policy replaces the default, including with an empty list.

## Real Rika Orb

- Thread: `247c199f-55e3-4b1c-94c1-401f73d1db67`.
- Thread creation: 2.880 seconds.
- No stored egress-policy row: confirmed before preparation.
- Workspace preparation: `2026-08-31T06:26:57.514Z` to
  `2026-08-31T06:27:33.060Z`, 35.546 seconds.
- This preparation reached `ready`, phase `capabilities`; its setup hook completed in 26.508
  seconds.
- Two later preparations failed during setup with Bun
  `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR` downloads from the explicitly allowed
  `registry.npmjs.org` hostname.
- Post-fix result: 1 ready preparation and 2 setup failures across 3 attempts and 2 assignments.
- The exact E2B image contract also built and ran its complete doctor locally in the parent
  checkout.

This proves that a fresh real Orb can pass E2B creation, bootstrap, confined npm access,
workspace setup, and capability readiness. It does **not** prove that the path is reliable: the
observed post-fix preparation success rate was only 1/3. The narrow source fix removes the known
missing-destination defect, but intermittent constrained-E2B TLS/setup reliability remains
unresolved. The 35.546-second successful sample is not an interactive-startup claim; Orb
preparation begins only after the first prompt and includes E2B placement and the repository's
setup hook.

E2B's current documentation says hostname filtering inspects HTTP `Host` on port 80 and TLS SNI
on port 443. A review of E2B JavaScript SDK 2.41.0 through the current 2.46.1 found no later SDK
change to hostname filtering, DNS, or in-sandbox TLS. Upgrading the client is therefore not an
evidence-backed remedy for these failures. No TLS bypass, broader wildcard, or speculative retry
was added.

## GLM-only provider boundary

Both old and fresh secret-backed orbs used or directly probed only OpenRouter
`z-ai/glm-5.3-flash`. OpenRouter returned HTTP 401 with `API key expired.` in both. Restarting the
fresh orb's processes did not refresh the injected secret.

The real Orb's first model attempt therefore failed before any model-directed file/tool action.
The following remain unproven in live E2B acceptance:

- required marker and final model response;
- Orb continuation and full reconnect UX after a successful model turn;
- Orb cancellation and post-cancellation recovery.

The packaged client did reattach at the transport level, with API-side attach measurements of
17-25 ms. A follow-up command did not become a durable submission because workspace preparation
failed again. Transport attachment is not substituted for the unproven successful-turn reconnect
flow.

Local Runner/provider-backed GLM evidence and deterministic TUI/process tests cover those product
paths separately, but they are not substituted for the blocked live E2B model flow.

## Code and focused verification

- The TypeScript credential scanner no longer mistakes
  `accessToken: Redacted.Redacted<string>` for literal credential material; real token literals
  remain rejected.
- New Orb preparation overlaps independent local seed work, identity lookup, seed upload, and
  ticket issuance.
- A missing stored setup policy now has the narrow setup defaults described above.
- E2B creation keeps the pre-create approved-build check and post-create template check, but drops
  a second build-status request that could not attest the created sandbox. E2B receives the exact
  immutable `<templateId>:<buildId>` reference.
- Product policy tests passed 3/3; E2B provider tests passed 9/9; the full unit suite and current
  E2B image doctor passed in the parent checkout.

No TLS bypass, unconstrained egress, speculative retry, prewarm daemon, template promotion,
deployment, publication, push, or merge was used.

## Pass/fail boundary

| Requirement | Result |
| --- | --- |
| Controlled missing-registry reproduction | Pass, 3/3 attempts failed as expected |
| Controlled registry-allowed install | Pass, one full 664-package install in 8.11 seconds |
| Real Orb Thread creation | Pass, one sample in 2.880 seconds |
| Real post-fix workspace preparation | Partial, 1/3 reached ready; 2/3 failed in npm TLS |
| GLM 5.3 Flash marker/tool/final response | Blocked, OpenRouter rejected the configured key as expired |
| Transport reattach | Pass at API boundary, 17-25 ms |
| Successful-turn continuation/reconnect UX | Not proven |
| Cancellation and recovery | Not proven |
