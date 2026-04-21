/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	streamSimple,
	type ToolCall,
	type ToolResultMessage,
	validateToolArguments,
} from "nami-ai";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	StreamFn,
} from "./types.js";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<void> {
	let firstTurn = true;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Stream assistant response
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");
			hasMoreToolCalls = toolCalls.length > 0;

			// Identity Enforcer: Check if model incorrectly identified itself
			if (!hasMoreToolCalls) {
				const textContent = message.content.find((c) => c.type === "text");
				if (textContent && textContent.type === "text") {
					const wrongIdentity = detectWrongIdentity(textContent.text);
					if (wrongIdentity) {
						const correctionMessage: AgentMessage = {
							role: "user",
							content: [
								{
									type: "text",
									text: `Reminder: Your name is NAMI. Do not introduce yourself as "${wrongIdentity}" or any other model name. Respond as NAMI.`,
								},
							],
							timestamp: Date.now(),
						};
						currentContext.messages.push(correctionMessage);
						newMessages.push(correctionMessage);
						await emit({ type: "message_start", message: correctionMessage });
						await emit({ type: "message_end", message: correctionMessage });
						continue;
					}
				}
			}

			// Tool-Call Enforcer: Check for text that looks like tool call JSON but wasn't emitted as tool call
			if (!hasMoreToolCalls && config.correctionPrompt) {
				const textContent = message.content.find((c) => c.type === "text");
				if (textContent && textContent.type === "text") {
					const detectedJson = detectToolCallJsonInText(textContent.text);
					if (detectedJson) {
						const correctionMessage = config.correctionPrompt(detectedJson);
						if (correctionMessage) {
							const correctionAgentMessage: AgentMessage = {
								role: "user",
								content: [{ type: "text", text: correctionMessage }],
								timestamp: Date.now(),
							};
							currentContext.messages.push(correctionAgentMessage);
							newMessages.push(correctionAgentMessage);
							await emit({ type: "message_start", message: correctionAgentMessage });
							await emit({ type: "message_end", message: correctionAgentMessage });
							continue;
						}
					}
				}
			}

			// JSON-Sieve: Intercept and execute JSON tool calls from text
			let interceptedToolCalls: ToolCall[] = [];
			if (!hasMoreToolCalls && config.interceptJsonToolCalls) {
				const textContent = message.content.find((c) => c.type === "text");
				if (textContent && textContent.type === "text") {
					interceptedToolCalls = parseAllInterceptedJsonToolCalls(textContent.text, currentContext.tools);
				}
			}

			const toolResults: ToolResultMessage[] = [];

			// Execute ALL intercepted JSON tool calls
			if (interceptedToolCalls.length > 0) {
				for (const toolCall of interceptedToolCalls) {
					const result = await executeSingleToolCall(currentContext, toolCall, config, signal, emit);
					if (result) {
						toolResults.push(result);
						currentContext.messages.push(result);
						newMessages.push(result);
					}
				}
			} else if (hasMoreToolCalls) {
				toolResults.push(...(await executeToolCalls(currentContext, message, config, signal, emit)));

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			await emit({ type: "turn_end", message, toolResults });

			pendingMessages = (await config.getSteeringMessages?.()) || [];
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);

	// Build LLM context
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	const streamFunction = streamFn || streamSimple;

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	const finalMessage = await response.result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	if (config.toolExecution === "sequential") {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	const results: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			results.push(await emitToolCallOutcome(toolCall, preparation.result, preparation.isError, emit));
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			results.push(
				await finalizeExecutedToolCall(
					currentContext,
					assistantMessage,
					preparation,
					executed,
					config,
					signal,
					emit,
				),
			);
		}
	}

	return results;
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	const results: ToolResultMessage[] = [];
	const runnableCalls: PreparedToolCall[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			results.push(await emitToolCallOutcome(toolCall, preparation.result, preparation.isError, emit));
		} else {
			runnableCalls.push(preparation);
		}
	}

	const runningCalls = runnableCalls.map((prepared) => ({
		prepared,
		execution: executePreparedToolCall(prepared, signal, emit),
	}));

	for (const running of runningCalls) {
		const executed = await running.execution;
		results.push(
			await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				running.prepared,
				executed,
				config,
				signal,
				emit,
			),
		);
	}

	return results;
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (beforeResult?.block) {
				return {
					kind: "immediate",
					result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
					isError: true,
				};
			}
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			},
		);
		await Promise.all(updateEvents);
		return { result, isError: false };
	} catch (error) {
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		const afterResult = await config.afterToolCall(
			{
				assistantMessage,
				toolCall: prepared.toolCall,
				args: prepared.args,
				result,
				isError,
				context: currentContext,
			},
			signal,
		);
		if (afterResult) {
			result = {
				content: afterResult.content ?? result.content,
				details: afterResult.details ?? result.details,
			};
			isError = afterResult.isError ?? isError;
		}
	}

	return await emitToolCallOutcome(prepared.toolCall, result, isError, emit);
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolCallOutcome(
	toolCall: AgentToolCall,
	result: AgentToolResult<any>,
	isError: boolean,
	emit: AgentEventSink,
): Promise<ToolResultMessage> {
	await emit({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
		isError,
	});

	const toolResultMessage: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		details: result.details,
		isError,
		timestamp: Date.now(),
	};

	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
	return toolResultMessage;
}

/**
 * Detect JSON that looks like a tool call embedded in text.
 * This is part of the Tool-Call Enforcer mechanism.
 *
 * @param text The text that may contain embedded JSON tool calls
 * @returns The detected JSON string or undefined if not found
 */
function detectToolCallJsonInText(text: string): string | undefined {
	if (!text) {
		return undefined;
	}

	// Pattern 1: Look for { "name": ... } or { "function": { "name": ... }
	const toolCallPattern = /\{\s*"(?:"function"|"name"|"tool"|"action")"\s*:/i;
	if (toolCallPattern.test(text)) {
		// Extract the JSON object
		const match = text.match(/\{[\s\S]*?"(?:function|name|tool|action)"[\s\S]*?\}/i);
		if (match) {
			const jsonText = match[0];
			try {
				const parsed = JSON.parse(jsonText);
				// Verify it looks like a tool call
				const hasName = parsed.name || parsed.function?.name || parsed.tool || parsed.action;
				const hasArgs = parsed.arguments || parsed.input || parsed.function?.arguments || parsed.function?.input;
				if (hasName && hasArgs) {
					return jsonText;
				}
			} catch {
				// Not valid JSON, ignore
			}
		}
	}

	// Pattern 2: Look for markdown-wrapped JSON with tool call structure
	const markdownMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?"name"[\s\S]*?\})\s*```/);
	if (markdownMatch) {
		try {
			const parsed = JSON.parse(markdownMatch[1]);
			if (parsed.name && parsed.arguments) {
				return markdownMatch[1];
			}
		} catch {
			// Ignore
		}
	}

	return undefined;
}

/**
 * Detect if the model incorrectly identified itself with a wrong name.
 * Returns the detected wrong identity or undefined if correct.
 */
function detectWrongIdentity(text: string): string | undefined {
	if (!text) {
		return undefined;
	}

	const lowerText = text.toLowerCase();

	// Patterns that indicate wrong identity
	const wrongIdentityPatterns = [
		/^i am (?:qwen|claude|gpt|gemini|chatgpt|llama|deepseek|mistral)/i,
		/^my name is (?:qwen|claude|gpt|gemini|chatgpt|llama|deepseek|mistral)/i,
		/^i'?m (?:qwen|claude|gpt|gemini|chatgpt|llama|deepseek|mistral)/i,
		/^i am an? (?:ai|language model|assistant|ai assistant)/i,
		/^i'?m an? (?:ai|language model|assistant|ai assistant)/i,
		/^(?:i am|i'?m) (?:created by|built by|developed by|from|made by)/i,
		/^i am a (?:large )?language model/i,
		/^i was (?:created|built|trained|developed)/i,
	];

	// Check first 500 chars to catch introductions
	const introText = lowerText.slice(0, 500);

	for (const pattern of wrongIdentityPatterns) {
		const match = introText.match(pattern);
		if (match) {
			// Extract the name from the match
			const fullMatch = match[0];
			const nameMatch = fullMatch.match(
				/(qwen|claude|gpt|gemini|chatgpt|llama|deepseek|mistral|ai|language model|assistant)/i,
			);
			if (nameMatch) {
				return nameMatch[1];
			}
			return fullMatch;
		}
	}

	// Also check for common phrases like "I am Qwen" or "I'm Claude"
	const explicitNames = ["qwen", "claude", "gpt-4", "gpt", "gemini", "chatgpt", "llama", "deepseek"];
	for (const name of explicitNames) {
		const patterns = [
			new RegExp(`\\bi am\\b.*\\b${name}\\b`, "i"),
			new RegExp(`\\bi'?m\\b.*\\b${name}\\b`, "i"),
			new RegExp(`\\bmy name is\\b.*\\b${name}\\b`, "i"),
			new RegExp(`\\bi was created by\\b.*\\b${name}\\b`, "i"),
		];
		for (const pattern of patterns) {
			if (pattern.test(introText)) {
				return name;
			}
		}
	}

	return undefined;
}

/**
 * Parse JSON tool calls from model output text (JSON-Sieve).
 * Returns array of detected tool calls.
 */
function parseAllInterceptedJsonToolCalls(jsonText: string, availableTools: AgentTool<any>[] | undefined): ToolCall[] {
	if (!jsonText || !availableTools?.length) {
		return [];
	}

	const toolNames = new Set(availableTools.map((t) => t.name));
	const found: ToolCall[] = [];

	// Fast pattern: find {"name": "toolname", "arguments": {...}}
	const pattern = /"name"\s*:\s*"(\w+)"\s*,\s*"arguments"\s*:/g;

	for (const match of jsonText.matchAll(pattern)) {
		const toolName = match[1];
		if (toolNames.has(toolName)) {
			found.push({
				type: "toolCall",
				id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
				name: toolName,
				arguments: {},
			});
		}
	}

	return found;
}

/**
 * Execute a single intercepted tool call and return its result.
 */
async function executeSingleToolCall(
	currentContext: AgentContext,
	toolCall: ToolCall,
	_config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage | undefined> {
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return undefined;
	}

	try {
		const validatedArgs = validateToolArguments(tool, toolCall);
		const prepared: PreparedToolCall = {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};

		const executed = await executePreparedToolCall(prepared, signal, emit);

		return {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: executed.result.content,
			details: executed.result.details as any,
			isError: executed.isError,
			timestamp: Date.now(),
		};
	} catch (error) {
		return {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: `Error: ${error}` }],
			details: {},
			isError: true,
			timestamp: Date.now(),
		};
	}
}
