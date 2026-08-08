# @rika/store

Owns the current Rika product SQLite schema and repositories. Raw SQL and SQLite clients remain inside this package. SQL and memory repository layers preserve the same constraints and ordering.

- `Database.layer` creates the current baseline for a fresh database and rejects every other existing schema without changing it.
