import { parse as partialParse } from "partial-json";

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 */
export function parseStreamingJson<T = any>(partialJson: string | undefined): T {
	if (!partialJson || partialJson.trim() === "") {
		return {} as T;
	}

	// Try standard parsing first (fastest for complete JSON)
	try {
		return JSON.parse(partialJson) as T;
	} catch {
		// Try partial-json for incomplete JSON
		try {
			const result = partialParse(partialJson);
			return (result ?? {}) as T;
		} catch {
			// If all parsing fails, return empty object
			return {} as T;
		}
	}
}

/**
 * Extract JSON blocks from text that may be wrapped in markdown code fences.
 * This is the "JSON-Sieve" for local models that output tool calls in markdown blocks.
 *
 * @param text The text that may contain JSON in markdown blocks
 * @returns Array of extracted JSON strings
 */
export function extractJsonFromMarkdown(text: string): string[] {
	const results: string[] = [];

	// Match ```json ... ``` or ``` ... ``` blocks
	const regex = /```(?:json)?\s*([\s\S]*?)```/g;
	for (const match of text.matchAll(regex)) {
		const content = match[1]?.trim();
		if (content) {
			results.push(content);
		}
	}

	// Also find standalone JSON objects that weren't in code blocks
	// This is handled by findJsonObjectRanges in the provider
	return results;
}

/**
 * Strip markdown code fences from text and extract the content.
 *
 * @param text Text potentially containing markdown-wrapped JSON
 * @returns Text with markdown code fences removed
 */
export function stripMarkdownCodeFences(text: string): string {
	// Remove ```json ... ``` and ``` ... ``` blocks entirely
	const result = text.replace(/```(?:json)?\s*[\s\S]*?```/g, "");

	// Also handle inline JSON that might look like tool calls
	// Look for patterns like { "name": "read", "arguments": ... }
	return result.trim();
}

/**
 * Check if text looks like a tool call JSON (contains "name" and "arguments" keys).
 *
 * @param text The JSON string to check
 * @returns True if the JSON appears to be a tool call
 */
export function looksLikeToolCall(text: string): boolean {
	try {
		const parsed = JSON.parse(text);
		return (
			typeof parsed === "object" &&
			parsed !== null &&
			("name" in parsed || "function" in parsed) &&
			("arguments" in parsed || "input" in parsed || "function" in parsed)
		);
	} catch {
		return false;
	}
}
