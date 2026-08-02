# @rika/product

Owns product operations and the lazy command dispatcher. It translates CLI and TUI requests into product services without importing OpenTUI, provider SDKs, raw SQL clients, or Relay internal packages.

Every operation is typed data. The dispatcher layer itself remains infrastructure-free so CLI help and parsing never initialize runtime dependencies.
