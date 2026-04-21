import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOllama } from "../src/providers/ollama.js";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, Tool } from "../src/types.js";
import type { AssistantMessageEventStream } from "../src/utils/event-stream.js";

const bashParameters = Type.Object({
	command: Type.String(),
});

const readParameters = Type.Object({
	path: Type.String(),
});

const bashTool: Tool<typeof bashParameters> = {
	name: "bash",
	description: "Run a shell command",
	parameters: bashParameters,
};

const readTool: Tool<typeof readParameters> = {
	name: "read",
	description: "Read a file",
	parameters: readParameters,
};

const ollamaModel: Model<"ollama"> = {
	id: "qwen2.5-coder:14b",
	name: "Qwen 2.5 Coder",
	api: "ollama",
	provider: "ollama",
	baseUrl: "http://ollama.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};

interface CapturedOllamaRequest {
	model: string;
	stream: boolean;
	messages: Array<Record<string, unknown>>;
	tools?: Array<{
		type: "function";
		function: {
			name: string;
			description: string;
			parameters: unknown;
		};
	}>;
}

function mockOllamaFetch(chunks: unknown[], captures: CapturedOllamaRequest[] = []): void {
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		captures.push(JSON.parse(String(init?.body)) as CapturedOllamaRequest);
		const body = `${chunks.map((chunk) => JSON.stringify(chunk)).join("\n")}\n`;
		return new Response(body, {
			status: 200,
			headers: { "Content-Type": "application/x-ndjson" },
		});
	});
}

async function collectStream(stream: AssistantMessageEventStream): Promise<{
	events: AssistantMessageEvent[];
	message: AssistantMessage;
}> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return { events, message: await stream.result() };
}

describe("Ollama tool calling", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends tools in Ollama function format and maps prior tool turns", async () => {
		const captures: CapturedOllamaRequest[] = [];
		mockOllamaFetch([{ message: { content: "done" }, done: true }], captures);

		const context: Context = {
			systemPrompt: "You are a coding agent.",
			messages: [
				{ role: "user", content: "read package.json", timestamp: 1 },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Reading it." },
						{ type: "toolCall", id: "tc_1", name: "read", arguments: { path: "package.json" } },
					],
					api: "ollama",
					provider: "ollama",
					model: "qwen2.5-coder:14b",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "tc_1",
					toolName: "read",
					content: [{ type: "text", text: '{"name":"nami"}' }],
					isError: false,
					timestamp: 3,
				},
			],
			tools: [readTool, bashTool],
		};

		await collectStream(streamOllama(ollamaModel, context));

		expect(captures).toHaveLength(1);
		expect(captures[0].tools?.map((tool) => tool.function.name)).toEqual(["read", "bash"]);
		expect(captures[0].messages).toEqual([
			{ role: "system", content: "You are a coding agent." },
			{ role: "user", content: "read package.json" },
			{
				role: "assistant",
				content: "Reading it.",
				tool_calls: [{ id: "tc_1", function: { name: "read", arguments: { path: "package.json" } } }],
			},
			{ role: "tool", tool_name: "read", content: '{"name":"nami"}' },
		]);
	});

	it("converts native Ollama tool calls into toolCall blocks", async () => {
		mockOllamaFetch([
			{
				message: {
					tool_calls: [{ function: { name: "read", arguments: { path: "package.json" } } }],
				},
				done: false,
			},
			{ done: true, prompt_eval_count: 7, eval_count: 3 },
		]);

		const { events, message } = await collectStream(
			streamOllama(ollamaModel, {
				messages: [{ role: "user", content: "read package.json", timestamp: Date.now() }],
				tools: [readTool],
			}),
		);

		expect(events.some((event) => event.type === "toolcall_start")).toBe(true);
		expect(events.some((event) => event.type === "toolcall_delta")).toBe(true);
		expect(events.some((event) => event.type === "toolcall_end")).toBe(true);
		expect(message.stopReason).toBe("toolUse");
		expect(message.usage.input).toBe(7);
		expect(message.usage.output).toBe(3);
		expect(message.content).toEqual([
			{ type: "toolCall", id: "ollama_call_1", name: "read", arguments: { path: "package.json" } },
		]);
	});

	it("converts exact raw JSON fallback into a hidden toolCall block", async () => {
		mockOllamaFetch([
			{ message: { content: '{"name":"bash",' }, done: false },
			{ message: { content: '"arguments":{"command":"ls"}}' }, done: false },
			{ done: true },
		]);

		const { events, message } = await collectStream(
			streamOllama(ollamaModel, {
				messages: [{ role: "user", content: "list files", timestamp: Date.now() }],
				tools: [bashTool],
			}),
		);

		expect(events.some((event) => event.type === "text_delta")).toBe(false);
		expect(message.stopReason).toBe("toolUse");
		expect(message.content).toEqual([
			{ type: "toolCall", id: "ollama_call_1", name: "bash", arguments: { command: "ls" } },
		]);
	});

	it("strips raw JSON from surrounding assistant text", async () => {
		mockOllamaFetch([
			{
				message: {
					content: 'I\'ll check.\n{"tool":"bash","arguments":{"command":"ls -la"}}\n',
				},
				done: false,
			},
			{ done: true },
		]);

		const { message } = await collectStream(
			streamOllama(ollamaModel, {
				messages: [{ role: "user", content: "list files", timestamp: Date.now() }],
				tools: [bashTool],
			}),
		);

		expect(message.stopReason).toBe("toolUse");
		expect(message.content).toEqual([
			{ type: "text", text: "I'll check." },
			{ type: "toolCall", id: "ollama_call_1", name: "bash", arguments: { command: "ls -la" } },
		]);
	});

	it("preserves multiple native tool calls in order", async () => {
		mockOllamaFetch([
			{
				message: {
					tool_calls: [
						{ function: { name: "bash", arguments: { command: "ls" } } },
						{ function: { name: "read", arguments: { path: "package.json" } } },
					],
				},
				done: false,
			},
			{ done: true },
		]);

		const { message } = await collectStream(
			streamOllama(ollamaModel, {
				messages: [{ role: "user", content: "inspect project", timestamp: Date.now() }],
				tools: [bashTool, readTool],
			}),
		);

		expect(message.stopReason).toBe("toolUse");
		expect(message.content).toEqual([
			{ type: "toolCall", id: "ollama_call_1", name: "bash", arguments: { command: "ls" } },
			{ type: "toolCall", id: "ollama_call_2", name: "read", arguments: { path: "package.json" } },
		]);
	});
});
