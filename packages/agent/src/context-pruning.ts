import type { Message, TextContent, ToolResultMessage, UserMessage } from "nami-ai";

export interface ContextPruningOptions {
	/** Maximum number of turns to keep (default: 10) */
	maxTurns?: number;
	/** Maximum total text content characters to keep per message (default: 4000) */
	maxCharsPerMessage?: number;
	/** Whether to preserve tool results (default: true) */
	preserveToolResults?: boolean;
}

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_MAX_CHARS = 4000;

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars - 3)}...`;
}

function truncateUserMessage(message: UserMessage, maxChars: number): UserMessage {
	if (typeof message.content === "string") {
		return { ...message, content: truncateText(message.content, maxChars) };
	}

	const truncated = message.content.map((c): TextContent | typeof c => {
		if (c.type === "text" && "text" in c && typeof c.text === "string" && c.text.length > maxChars) {
			return { ...c, text: truncateText(c.text, maxChars) };
		}
		return c;
	});

	return { ...message, content: truncated as TextContent[] };
}

function truncateToolResultMessage(message: ToolResultMessage, maxChars: number): ToolResultMessage {
	const truncated = message.content.map((c): TextContent | typeof c => {
		if (c.type === "text" && "text" in c && typeof c.text === "string" && c.text.length > maxChars) {
			return { ...c, text: truncateText(c.text, maxChars) };
		}
		return c;
	});

	return { ...message, content: truncated as TextContent[] };
}

function truncateMessage(message: Message, maxChars: number): Message {
	if (message.role === "user") {
		return truncateUserMessage(message, maxChars);
	}
	if (message.role === "toolResult") {
		return truncateToolResultMessage(message, maxChars);
	}
	return message;
}

export function pruneContext(messages: Message[], options: ContextPruningOptions = {}): Message[] {
	const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
	const maxChars = options.maxCharsPerMessage ?? DEFAULT_MAX_CHARS;
	const preserveToolResults = options.preserveToolResults ?? true;

	if (messages.length <= maxTurns * 2) {
		return messages;
	}

	const result: Message[] = [];
	let turnCount = 0;

	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];

		const isToolResult = message.role === "toolResult";
		const isUserOrAssistant = message.role === "user" || message.role === "assistant";

		if (!isToolResult && !isUserOrAssistant) {
			continue;
		}

		if (preserveToolResults && isToolResult) {
			result.unshift(truncateMessage(message, maxChars));
			continue;
		}

		turnCount++;

		if (turnCount <= maxTurns) {
			result.unshift(truncateMessage(message, maxChars));
		}
	}

	return result;
}

export function countMessages(messages: Message[]): { turns: number; toolResults: number; total: number } {
	let turns = 0;
	let toolResults = 0;

	for (const message of messages) {
		if (message.role === "toolResult") {
			toolResults++;
		} else if (message.role === "user" || message.role === "assistant") {
			turns++;
		}
	}

	return { turns, toolResults, total: messages.length };
}
