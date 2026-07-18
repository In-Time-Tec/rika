# Versioned Workflows

Workflows are versioned Rika data compiled to Relay durable operations. Rika provides `delivery` and `research-synthesis`; callers can start a named run with an optional revision, then inspect or cancel it by run identifier.

Each run pins its workflow definition revision and digest. Relay owns runtime state for sequences, parallel work, joins, waits, retries, budgets, cancellation, compensation, and structured completion, so inspection and recovery use the same durable run after process failure. Rika does not execute model-authored workflow code.
