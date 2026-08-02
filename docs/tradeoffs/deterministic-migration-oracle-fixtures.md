# Deterministic migration oracle fixtures

**Gain:** the product-store preflight oracle receives identical SQLite inputs on every platform.

**Cost:** binary SQLite fixtures accompany the oracle metadata.

**Rejected:** generating preflight databases at test time makes SQLite serialization part of the assertion and causes platform-specific failures unrelated to migration behavior.
