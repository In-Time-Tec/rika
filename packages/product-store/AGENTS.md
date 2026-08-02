# @rika/product-store

Owns Rika product SQLite migrations and repositories. Raw SQL and SQLite clients remain inside this package. SQL and memory repository layers preserve the same constraints and ordering.

- `Database.layer` checks existing databases without writing, migrates known older schemas, and rejects unknown or future schemas without changing them.
- Keep migration ids and existing migration behavior stable. Prefer additive migrations and preserve stored product data.
