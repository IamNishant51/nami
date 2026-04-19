import type {
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";

/**
 * Ollama provider options.
 */
export interface OllamaOptions extends StreamOptions {
	numKeep?: number;
	maxTokens?: number;
	temperature?: number;
	topP?: number;
	topK?: number;
	repeatPenalty?: number;
	seed?: number;
}

/**
 * Get text content from a message
 */
function getMessageContent(m: Message): string {
	if (typeof m.content === "string") return m.content;
	let text = "";
	if (Array.isArray(m.content)) {
		for (const c of m.content) {
			if (c.type === "text") text += c.text;
		}
	}
	return text;
}

/**
 * Stream responses from Ollama.
 */
export const streamOllama: StreamFunction<"ollama", OllamaOptions> = (
	model: Model<"ollama">,
	context: Context,
	_options?: OllamaOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		try {
			const baseUrl = model.baseUrl || "http://localhost:11434";

			// Convert messages to Ollama format
			const ollamaMessages = context.messages
				.filter((m): m is Message => m !== undefined)
				.map((m) => ({
					role: m.role === "assistant" ? "assistant" : m.role,
					content: getMessageContent(m),
				}))
				.filter((m) => m.content);

			const requestBody: Record<string, unknown> = {
				model: model.id,
				messages: ollamaMessages,
				stream: true,
			};

			stream.push({
				type: "start",
				partial: {
					role: "assistant",
					content: [],
					api: "ollama",
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
			});

			const response = await fetch(`${baseUrl}/api/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(requestBody),
			});

			if (!response.ok) {
				throw new Error(`Ollama API error: ${response.status}`);
			}

			const reader = response.body?.getReader();
			if (!reader) throw new Error("No response body");

			const decoder = new TextDecoder();
			let buffer = "";

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.trim()) continue;

					try {
						const data = JSON.parse(line);
						if (data.message?.content) {
							const textContent: TextContent = { type: "text", text: data.message.content };
							stream.push({
								type: "text_delta",
								contentIndex: 0,
								delta: data.message.content,
								partial: {
									role: "assistant",
									content: [textContent],
									api: "ollama",
									provider: model.provider,
									model: model.id,
									usage: {
										input: 0,
										output: 0,
										cacheRead: 0,
										cacheWrite: 0,
										totalTokens: 0,
										cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
									},
									stopReason: "stop",
									timestamp: Date.now(),
								},
							});
						}

						if (data.done) {
							stream.push({
								type: "done",
								reason: "stop",
								message: {
									role: "assistant",
									content: [],
									api: "ollama",
									provider: model.provider,
									model: model.id,
									usage: {
										input: data.prompt_eval_count || 0,
										output: data.eval_count || 0,
										cacheRead: 0,
										cacheWrite: 0,
										totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
										cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
									},
									stopReason: "stop",
									timestamp: Date.now(),
								},
							});
							stream.end();
							return;
						}
					} catch {
						// Skip parse errors
					}
				}
			}
		} catch (error) {
			stream.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [],
					api: "ollama",
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					timestamp: Date.now(),
					errorMessage: error instanceof Error ? error.message : String(error),
				},
			});
			stream.end();
		}
	})();

	return stream;
};

/**
 * Simple Ollama stream.
 */
export const streamSimpleOllama: StreamFunction<"ollama", SimpleStreamOptions> = (
	model: Model<"ollama">,
	context: Context,
	_options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	return streamOllama(model, context);
};

/**
 * Get available Ollama models.
 */
export async function getOllamaModels(baseUrl: string = "http://localhost:11434"): Promise<string[]> {
	try {
		const response = await fetch(`${baseUrl}/api/tags`);
		if (!response.ok) return [];
		const data = (await response.json()) as { models: { name: string }[] };
		return data.models?.map((m) => m.name) || [];
	} catch {
		return [];
	}
}
