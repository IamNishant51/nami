import { Type } from "@sinclair/typebox";
import type { AgentTool } from "nami-agent-core";
import type { Model } from "nami-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOllama } from "../../../../ai/src/providers/ollama.js";
import { createHarness, getAssistantTexts, type Harness } from "../harness.js";

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

function mockOllamaFetchSequence(responses: unknown[][]): void {
	let index = 0;
	vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
		const chunks = responses[index];
		index++;
		if (!chunks) {
			return new Response(`${JSON.stringify({ message: { content: "unexpected" }, done: true })}\n`, {
				status: 200,
			});
		}
		return new Response(`${chunks.map((chunk) => JSON.stringify(chunk)).join("\n")}\n`, {
			status: 200,
			headers: { "Content-Type": "application/x-ndjson" },
		});
	});
}

describe("local Ollama raw JSON tool calls", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("executes raw JSON as a structured tool call and continues the agent loop", async () => {
		const toolRuns: string[] = [];
		const bashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Run shell commands",
			parameters: Type.Object({ command: Type.String() }),
			execute: async (_toolCallId, params) => {
				const command =
					typeof params === "object" && params !== null && "command" in params ? String(params.command) : "";
				toolRuns.push(command);
				return {
					content: [{ type: "text", text: "package.json\nsrc" }],
					details: { command },
				};
			},
		};

		const harness = await createHarness({ tools: [bashTool] });
		harnesses.push(harness);
		harness.session.agent.state.model = ollamaModel;
		harness.session.agent.streamFn = streamOllama as unknown as typeof harness.session.agent.streamFn;

		mockOllamaFetchSequence([
			[
				{
					message: { content: '{"name":"bash","arguments":{"command":"ls"}}' },
					done: false,
				},
				{ done: true },
			],
			[{ message: { content: "package.json\nsrc" }, done: true }],
		]);

		await harness.session.prompt("list files");

		expect(toolRuns).toEqual(["ls"]);
		expect(harness.events.some((event) => event.type === "tool_execution_start")).toBe(true);
		expect(harness.events.some((event) => event.type === "tool_execution_end")).toBe(true);
		expect(harness.session.messages.some((message) => message.role === "toolResult")).toBe(true);
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);

		const assistantMessages = harness.session.messages.filter((message) => message.role === "assistant");
		expect(assistantMessages).toHaveLength(2);
		expect(assistantMessages[0]?.role).toBe("assistant");
		if (assistantMessages[0]?.role === "assistant") {
			expect(assistantMessages[0].content.some((content) => content.type === "toolCall")).toBe(true);
			expect(getAssistantTexts(harness)[0]).not.toContain('"name":"bash"');
		}
		expect(getAssistantTexts(harness).at(-1)).toBe("package.json\nsrc");
	});
});
