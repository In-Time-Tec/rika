# Automatic Thread titles

A new interactive Thread starts with a temporary title derived from its first prompt. After the first Turn completes, Rika asks the pinned title route for a concise title, stores up to eighty characters, and updates the open terminal and Thread summaries.

Title generation uses a separate durable Execution and never changes the completed Turn. Rika resumes or replays that Execution after restart, and its model usage contributes to the first Turn, Thread, and global cost totals. An unavailable route, failed request, or empty response leaves the existing title in place.
