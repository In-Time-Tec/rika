# Repository policy

Keep policy checks pure and remediation-oriented. The process entrypoint is the only filesystem boundary. Policy evaluates the current manifests, source files, generated-output paths, and test topology directly; it has no baseline inventory, pinned revision, or migration-waiver bypass. The test-ownership exception file is limited to named broader tests for source modules without same-stem tests and is validated as an actual relationship. Framework configuration basenames are allowed only through the maintained exact-name rule in the policy module.
