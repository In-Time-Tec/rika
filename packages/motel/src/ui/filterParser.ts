/**
 * Parses the `/` filter input in the trace list into its component
 * modifiers. Supports composable tokens:
 *
 * - `:error`           — restricts to traces with at least one failed span
 * - `:ai <query...>`   — FTS-backed search against LLM prompt/response
 *                        content (AI_FTS_KEYS) across every span in the
 *                        trace. The query runs up to the next `:modifier`
 *                        or end of input, so `"/ :ai rate limit :error"`
 *                        passes `"rate limit"` as the aiText and also
 *                        sets errorOnly.
 * - bare text          — case-insensitive substring match against the
 *                        trace's root operation name (client-side)
 *
 * Keep this a pure function: it's unit-tested separately and the React
 * hook just calls it per render.
 */
export interface ParsedFilter {
	readonly aiText: string | null
	readonly errorOnly: boolean
	readonly operationNeedle: string
}

export const parseFilterText = (raw: string): ParsedFilter => {
	const text = raw ?? ""

	// `:ai <query>` — greedy up to the next `:` modifier or end. The
	// leading `(^|\s)` guard prevents matching a stray `:ai` glued to
	// non-space characters (shouldn't happen in practice but cheap).
	const aiMatch = text.match(/(?:^|\s):ai\s+([^:]*?)(?=\s:|$)/i)
	const aiText = aiMatch?.[1]?.trim() || null

	const errorOnly = /(?:^|\s):error(?=\s|$)/i.test(text)

	// Whatever remains after removing the recognized modifiers becomes the
	// operation-name needle. Lowercased here so the call site can do a
	// plain includes() without re-lowercasing.
	const operationNeedle = text
		.replace(/(?:^|\s):ai\s+[^:]*?(?=\s:|$)/i, " ")
		.replace(/(?:^|\s):error(?=\s|$)/i, " ")
		.trim()
		.toLowerCase()

	return { aiText, errorOnly, operationNeedle }
}
