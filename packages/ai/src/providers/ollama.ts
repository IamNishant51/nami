import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	Tool,
	ToolCall,
	Usage,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { extractJsonFromMarkdown, stripMarkdownCodeFences } from "../utils/json-parse.js";

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

interface OllamaTool {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: unknown;
	};
}

interface OllamaToolCall {
	id?: string;
	function?: {
		name?: string;
		arguments?: unknown;
	};
}

type OllamaMessage =
	| { role: "system" | "user"; content: string }
	| { role: "assistant"; content?: string; tool_calls?: OllamaToolCall[] }
	| { role: "tool"; tool_name: string; content: string };

interface OllamaChunk {
	message?: {
		content?: string;
		tool_calls?: OllamaToolCall[];
	};
	done?: boolean;
	prompt_eval_count?: number;
	eval_count?: number;
}

interface ParsedRawToolCall {
	range: { start: number; end: number };
	toolCall: ToolCall;
	isMarkdownBlock?: boolean;
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function usageFromOllama(data: OllamaChunk | undefined): Usage {
	const input = data?.prompt_eval_count ?? 0;
	const output = data?.eval_count ?? 0;
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistantMessage(model: Model<"ollama">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "ollama",
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function getTextContent(message: Message): string {
	if (typeof message.content === "string") {
		return message.content;
	}

	let text = "";
	for (const content of message.content) {
		if (content.type === "text") {
			text += content.text;
		}
	}
	return text;
}

function getAssistantText(message: Message): string {
	if (!Array.isArray(message.content)) {
		return "";
	}

	let text = "";
	for (const content of message.content) {
		if (content.type === "text") {
			text += content.text;
		}
	}
	return text;
}

function getToolCalls(message: Message): ToolCall[] {
	if (!Array.isArray(message.content)) {
		return [];
	}
	return message.content.filter((content): content is ToolCall => content.type === "toolCall");
}

function toOllamaToolCall(toolCall: ToolCall): OllamaToolCall {
	return {
		id: toolCall.id,
		function: {
			name: toolCall.name,
			arguments: toolCall.arguments,
		},
	};
}

function convertMessagesToOllama(context: Context): OllamaMessage[] {
	const messages: OllamaMessage[] = [];

	const systemPrompt = context.systemPrompt?.trim();
	if (systemPrompt) {
		messages.push({ role: "system", content: systemPrompt });
	}

	for (const message of context.messages) {
		if (message.role === "user") {
			const content = getTextContent(message);
			if (content) {
				messages.push({ role: "user", content });
			}
			continue;
		}

		if (message.role === "assistant") {
			const content = getAssistantText(message);
			const toolCalls = getToolCalls(message).map(toOllamaToolCall);
			if (content || toolCalls.length > 0) {
				const ollamaMessage: OllamaMessage = { role: "assistant" };
				if (content) {
					ollamaMessage.content = content;
				}
				if (toolCalls.length > 0) {
					ollamaMessage.tool_calls = toolCalls;
				}
				messages.push(ollamaMessage);
			}
			continue;
		}

		const content = getTextContent(message);
		messages.push({
			role: "tool",
			tool_name: message.toolName,
			content,
		});
	}

	return messages;
}

/**
 * Convert tools to Ollama's documented function-calling format.
 */
function convertToolsToOllamaFormat(tools: Tool[] | undefined): OllamaTool[] | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}

	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	}));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOllamaArguments(value: unknown): Record<string, unknown> {
	if (isPlainObject(value)) {
		return value;
	}
	if (typeof value !== "string") {
		return {};
	}

	try {
		const parsed = JSON.parse(value) as unknown;
		return isPlainObject(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function validateRawToolCall(
	value: unknown,
	availableToolNames: Set<string>,
	createId: () => string,
): ToolCall | undefined {
	if (!isPlainObject(value) || availableToolNames.size === 0) {
		return undefined;
	}

	const keys = Object.keys(value);
	if (keys.length !== 2) {
		return undefined;
	}

	const hasName = Object.hasOwn(value, "name");
	const hasTool = Object.hasOwn(value, "tool");
	if (hasName === hasTool || !Object.hasOwn(value, "arguments")) {
		return undefined;
	}

	const rawName = hasName ? value.name : value.tool;
	if (typeof rawName !== "string" || !availableToolNames.has(rawName)) {
		return undefined;
	}

	const args = value.arguments;
	if (!isPlainObject(args)) {
		return undefined;
	}

	return {
		type: "toolCall",
		id: createId(),
		name: rawName,
		arguments: args,
	};
}

function findJsonObjectRanges(text: string): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = [];
	let start = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];

		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}

		if (char === "{") {
			if (depth === 0) {
				start = i;
			}
			depth++;
			continue;
		}

		if (char === "}" && depth > 0) {
			depth--;
			if (depth === 0 && start >= 0) {
				ranges.push({ start, end: i + 1 });
				start = -1;
			}
		}
	}

	return ranges;
}

function extractRawToolCalls(
	text: string,
	availableToolNames: Set<string>,
	createId: () => string,
): { text: string; toolCalls: ToolCall[] } {
	const accepted: ParsedRawToolCall[] = [];

	// First, extract JSON from markdown code blocks (the "JSON-Sieve")
	const markdownJsonBlocks = extractJsonFromMarkdown(text);
	for (const jsonBlock of markdownJsonBlocks) {
		try {
			// Try parsing the entire block as a single tool call
			const candidate = JSON.parse(jsonBlock) as unknown;
			const toolCall = validateRawToolCall(candidate, availableToolNames, createId);
			if (toolCall) {
				accepted.push({ range: { start: 0, end: 0 }, toolCall, isMarkdownBlock: true });
			} else {
				// Try finding multiple tool calls in the block
				for (const range of findJsonObjectRanges(jsonBlock)) {
					const candidateText = jsonBlock.slice(range.start, range.end);
					try {
						const parsed = JSON.parse(candidateText) as unknown;
						const tc = validateRawToolCall(parsed, availableToolNames, createId);
						if (tc) {
							accepted.push({ range, toolCall: tc, isMarkdownBlock: true });
						}
					} catch {
						// Ignore
					}
				}
			}
		} catch {
			// Try finding individual objects in the block
			for (const range of findJsonObjectRanges(jsonBlock)) {
				const candidateText = jsonBlock.slice(range.start, range.end);
				try {
					const candidate = JSON.parse(candidateText) as unknown;
					const toolCall = validateRawToolCall(candidate, availableToolNames, createId);
					if (toolCall) {
						accepted.push({ range, toolCall, isMarkdownBlock: true });
					}
				} catch {
					// Ignore
				}
			}
		}
	}

	// Also find JSON objects in plain text (non-markdown)
	for (const range of findJsonObjectRanges(text)) {
		const candidateText = text.slice(range.start, range.end);
		// Skip if this overlaps with markdown block content we already processed
		const alreadyProcessed = accepted.some(
			(a) => a.isMarkdownBlock && candidateText.includes(JSON.stringify(a.toolCall)),
		);
		if (alreadyProcessed) {
			continue;
		}
		try {
			const candidate = JSON.parse(candidateText) as unknown;
			const toolCall = validateRawToolCall(candidate, availableToolNames, createId);
			if (toolCall) {
				accepted.push({ range, toolCall });
			}
		} catch {
			// Ignore incomplete or non-JSON text. The fallback only accepts exact JSON objects.
		}
	}

	if (accepted.length === 0) {
		// Strip markdown code fences from visible text if no tool calls found
		return { text: stripMarkdownCodeFences(text), toolCalls: [] };
	}

	// Remove markdown code blocks from visible text
	let visibleText = stripMarkdownCodeFences(text);

	// Remove the JSON objects that we extracted (only plain ones need to be removed from text)
	const plainToolCalls = accepted.filter((a) => !a.isMarkdownBlock);

	// For non-markdown JSON objects, remove them from the visible text
	for (const item of [...plainToolCalls].reverse()) {
		visibleText = `${visibleText.slice(0, item.range.start)}${visibleText.slice(item.range.end)}`;
	}

	return {
		text: visibleText.trim(),
		toolCalls: accepted.map((item) => item.toolCall),
	};
}

function emitTextBlock(stream: AssistantMessageEventStream, output: AssistantMessage, text: string): void {
	if (!text) {
		return;
	}

	const contentIndex = output.content.length;
	const content: TextContent = { type: "text", text: "" };
	output.content.push(content);
	stream.push({ type: "text_start", contentIndex, partial: { ...output, content: [...output.content] } });
	content.text = text;
	stream.push({ type: "text_delta", contentIndex, delta: text, partial: { ...output, content: [...output.content] } });
	stream.push({ type: "text_end", contentIndex, content: text, partial: { ...output, content: [...output.content] } });
}

function emitToolCall(stream: AssistantMessageEventStream, output: AssistantMessage, toolCall: ToolCall): void {
	const contentIndex = output.content.length;
	const partialToolCall: ToolCall = {
		type: "toolCall",
		id: toolCall.id,
		name: toolCall.name,
		arguments: {},
	};
	output.content.push(partialToolCall);
	stream.push({ type: "toolcall_start", contentIndex, partial: { ...output, content: [...output.content] } });

	const argsJson = JSON.stringify(toolCall.arguments);
	if (argsJson) {
		stream.push({
			type: "toolcall_delta",
			contentIndex,
			delta: argsJson,
			partial: { ...output, content: [...output.content] },
		});
	}

	partialToolCall.arguments = toolCall.arguments;
	stream.push({
		type: "toolcall_end",
		contentIndex,
		toolCall,
		partial: { ...output, content: [...output.content] },
	});
}

function fromOllamaToolCall(toolCall: OllamaToolCall, createId: () => string): ToolCall | undefined {
	const name = toolCall.function?.name;
	if (!name) {
		return undefined;
	}

	return {
		type: "toolCall",
		id: toolCall.id || createId(),
		name,
		arguments: parseOllamaArguments(toolCall.function?.arguments),
	};
}

/**
 * Stream responses from Ollama.
 */
export const streamOllama: StreamFunction<"ollama", OllamaOptions> = (
	model: Model<"ollama">,
	context: Context,
	options?: OllamaOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const output = createAssistantMessage(model);
	const availableToolNames = new Set((context.tools ?? []).map((tool) => tool.name));
	let contentBuffer = "";
	let toolCallCounter = 0;
	let finished = false;

	const nextToolCallId = (): string => {
		toolCallCounter++;
		return `ollama_call_${toolCallCounter}`;
	};

	const finish = (data: OllamaChunk | undefined): void => {
		if (finished) {
			return;
		}
		finished = true;

		const rawToolParse = extractRawToolCalls(contentBuffer, availableToolNames, nextToolCallId);
		emitTextBlock(stream, output, rawToolParse.text);
		for (const toolCall of rawToolParse.toolCalls) {
			emitToolCall(stream, output, toolCall);
		}

		output.usage = usageFromOllama(data);
		output.stopReason = output.content.some((content) => content.type === "toolCall") ? "toolUse" : "stop";
		stream.push({
			type: "done",
			reason: output.stopReason === "toolUse" ? "toolUse" : "stop",
			message: output,
		});
		stream.end();
	};

	(async () => {
		try {
			const baseUrl = model.baseUrl || "http://localhost:11434";
			stream.push({ type: "start", partial: { ...output, content: [] } });

			const makeRequest = async (withTools: boolean): Promise<Response> => {
				const requestBody: Record<string, unknown> = {
					model: model.id,
					messages: convertMessagesToOllama(context),
					stream: true,
				};

				if (withTools) {
					const tools = convertToolsToOllamaFormat(context.tools);
					if (tools && tools.length > 0) {
						requestBody.tools = tools;
					}
				}

				const ollamaOptions: Record<string, number> = {};
				if (options?.temperature !== undefined) {
					ollamaOptions.temperature = options.temperature;
				}
				if (options?.topP !== undefined) {
					ollamaOptions.top_p = options.topP;
				}
				if (options?.topK !== undefined) {
					ollamaOptions.top_k = options.topK;
				}
				if (options?.repeatPenalty !== undefined) {
					ollamaOptions.repeat_penalty = options.repeatPenalty;
				}
				if (options?.seed !== undefined) {
					ollamaOptions.seed = options.seed;
				}
				if (options?.numKeep !== undefined) {
					ollamaOptions.num_keep = options.numKeep;
				}
				if (options?.maxTokens !== undefined) {
					ollamaOptions.num_predict = options.maxTokens;
				}
				if (Object.keys(ollamaOptions).length > 0) {
					requestBody.options = ollamaOptions;
				}

				return fetch(`${baseUrl}/api/chat`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(requestBody),
					signal: options?.signal,
				});
			};

			// Try with tools first; if 400, retry without
			let response = await makeRequest(true);

			// If 400, retry without tools
			if (response.status === 400) {
				console.warn("Ollama 400 with tools, retrying without...");
				response = await makeRequest(false);
			}

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Ollama API error: ${response.status} - ${errorText.slice(0, 500)}`);
			}

			const reader = response.body?.getReader();
			if (!reader) {
				throw new Error("No response body");
			}

			const decoder = new TextDecoder();
			let buffer = "";

			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) {
						continue;
					}

					const data = JSON.parse(trimmed) as OllamaChunk;
					const message = data.message;

					if (message?.content) {
						contentBuffer += message.content;
					}

					for (const nativeToolCall of message?.tool_calls ?? []) {
						const toolCall = fromOllamaToolCall(nativeToolCall, nextToolCallId);
						if (toolCall) {
							emitToolCall(stream, output, toolCall);
						}
					}

					if (data.done) {
						finish(data);
						return;
					}
				}
			}

			if (buffer.trim()) {
				const data = JSON.parse(buffer.trim()) as OllamaChunk;
				if (data.message?.content) {
					contentBuffer += data.message.content;
				}
				for (const nativeToolCall of data.message?.tool_calls ?? []) {
					const toolCall = fromOllamaToolCall(nativeToolCall, nextToolCallId);
					if (toolCall) {
						emitToolCall(stream, output, toolCall);
					}
				}
				finish(data);
				return;
			}

			finish(undefined);
		} catch (error) {
			const aborted = options?.signal?.aborted;
			output.stopReason = aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({
				type: "error",
				reason: aborted ? "aborted" : "error",
				error: output,
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
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	return streamOllama(model, context, options);
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
