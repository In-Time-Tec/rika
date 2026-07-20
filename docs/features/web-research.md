# Web research

Agents use `web_search` to obtain ranked current-web excerpts and `read_web_page` to turn a public HTTP or HTTPS page into bounded Markdown. Searches require an objective. `auto` chooses the best configured provider for a normal search; `compare` queries up to three suitable providers for disputed, recent, safety-critical, or high-impact claims. Exa handles both web search and semantic code examples through one provider. GitHub search targets exact code, repositories, issues, pull requests, and commits. Agents cite result URLs, identify source disagreement, and fetch authoritative pages when snippets are insufficient rather than querying every provider every time.

Rika registers only configured providers. `web_search` is omitted when none are available. `read_web_page` remains Parallel-backed and is omitted unless Parallel is configured. Provider absence therefore cannot produce a model-visible tool that is known to be unusable.

Credentials in URLs and non-HTTP protocols are rejected. Missing service credentials, network or HTTP errors, invalid responses, extraction failures, and unavailable requested full content return typed failures; returned source text is bounded.
