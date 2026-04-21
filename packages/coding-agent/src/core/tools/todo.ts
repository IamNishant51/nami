import { type Static, Type } from "@sinclair/typebox";
import type { AgentTool } from "nami-agent-core";
import type { ToolDefinition } from "../extensions/types.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

export interface TodoItem {
	id: string;
	content: string;
	status: "pending" | "in_progress" | "completed" | "cancelled";
	priority: "low" | "medium" | "high";
	createdAt: number;
	updatedAt: number;
}

export interface TodoState {
	items: Map<string, TodoItem>;
}

const todoSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("add"),
			Type.Literal("update"),
			Type.Literal("complete"),
			Type.Literal("cancel"),
			Type.Literal("list"),
			Type.Literal("get"),
		],
		{ description: "Action to perform: add, update, complete, cancel, list, or get" },
	),
	id: Type.Optional(Type.String({ description: "Todo ID (required for update/complete/cancel/get)" })),
	content: Type.Optional(Type.String({ description: "Todo content (required for add/update)" })),
	status: Type.Optional(
		Type.Union(
			[Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("cancelled")],
			{
				description: "Status (optional for update)",
			},
		),
	),
	priority: Type.Optional(
		Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
			description: "Priority level (optional for add/update)",
		}),
	),
});

export type TodoToolInput = Static<typeof todoSchema>;

export interface TodoToolDetails {
	todos?: TodoItem[];
	todo?: TodoItem;
}

function generateId(): string {
	return `todo_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function createTodoTool(stateRef: { current: TodoState }): AgentTool<typeof todoSchema, TodoToolDetails> {
	const tool: AgentTool<typeof todoSchema, TodoToolDetails> = {
		name: "todowrite",
		label: "todowrite",
		description:
			"Manage a todo list for tracking tasks. Use to plan and track multi-step tasks. Always use todowrite when the user asks you to plan or track tasks.",
		parameters: todoSchema,
		execute: async (_toolCallId, params) => {
			const { action, id, content, status, priority } = params;
			const state = stateRef.current;

			switch (action) {
				case "add": {
					if (!content) {
						return {
							content: [{ type: "text", text: "Error: content is required for add action" }],
							details: {},
						};
					}
					const newTodo: TodoItem = {
						id: generateId(),
						content,
						status: "pending",
						priority: priority || "medium",
						createdAt: Date.now(),
						updatedAt: Date.now(),
					};
					state.items.set(newTodo.id, newTodo);
					return {
						content: [{ type: "text", text: `Added todo: [${newTodo.id.slice(0, 8)}] ${content}` }],
						details: { todo: newTodo },
					};
				}

				case "update": {
					if (!id || !content) {
						return {
							content: [{ type: "text", text: "Error: id and content are required for update action" }],
							details: {},
						};
					}
					const existing = state.items.get(id);
					if (!existing) {
						return {
							content: [{ type: "text", text: `Error: todo ${id} not found` }],
							details: {},
						};
					}
					existing.content = content;
					if (status) {
						existing.status = status;
					}
					if (priority) {
						existing.priority = priority;
					}
					existing.updatedAt = Date.now();
					return {
						content: [{ type: "text", text: `Updated todo: [${id.slice(0, 8)}] ${content}` }],
						details: { todo: existing },
					};
				}

				case "complete": {
					if (!id) {
						return {
							content: [{ type: "text", text: "Error: id is required for complete action" }],
							details: {},
						};
					}
					const existing = state.items.get(id);
					if (!existing) {
						return {
							content: [{ type: "text", text: `Error: todo ${id} not found` }],
							details: {},
						};
					}
					existing.status = "completed";
					existing.updatedAt = Date.now();
					return {
						content: [{ type: "text", text: `Completed todo: [${id.slice(0, 8)}] ${existing.content}` }],
						details: { todo: existing },
					};
				}

				case "cancel": {
					if (!id) {
						return {
							content: [{ type: "text", text: "Error: id is required for cancel action" }],
							details: {},
						};
					}
					const existing = state.items.get(id);
					if (!existing) {
						return {
							content: [{ type: "text", text: `Error: todo ${id} not found` }],
							details: {},
						};
					}
					existing.status = "cancelled";
					existing.updatedAt = Date.now();
					return {
						content: [{ type: "text", text: `Cancelled todo: [${id.slice(0, 8)}] ${existing.content}` }],
						details: { todo: existing },
					};
				}

				case "list": {
					const todos = Array.from(state.items.values()).sort((a, b) => {
						const priorityOrder = { high: 0, medium: 1, low: 2 };
						return priorityOrder[a.priority] - priorityOrder[b.priority];
					});
					if (todos.length === 0) {
						return {
							content: [{ type: "text", text: "No todos. Use todowrite add to create one." }],
							details: { todos: [] },
						};
					}
					const lines = todos.map((t) => {
						const statusIcon =
							t.status === "completed"
								? "✓"
								: t.status === "in_progress"
									? "▶"
									: t.status === "cancelled"
										? "✗"
										: "○";
						return `${statusIcon} [${t.id.slice(0, 8)}] ${t.content} (${t.priority})`;
					});
					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: { todos },
					};
				}

				case "get": {
					if (!id) {
						return {
							content: [{ type: "text", text: "Error: id is required for get action" }],
							details: {},
						};
					}
					const existing = state.items.get(id);
					if (!existing) {
						return {
							content: [{ type: "text", text: `Error: todo ${id} not found` }],
							details: {},
						};
					}
					return {
						content: [
							{
								type: "text",
								text: `[${existing.id.slice(0, 8)}] ${existing.content}\nStatus: ${existing.status}\nPriority: ${existing.priority}`,
							},
						],
						details: { todo: existing },
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Error: unknown action ${action}` }],
						details: {},
					};
			}
		},
	};

	return tool;
}

export function createTodoToolDefinition(stateRef: {
	current: TodoState;
}): ToolDefinition<typeof todoSchema, TodoToolDetails> {
	const tool = createTodoTool(stateRef);
	return wrapToolDefinition(tool);
}

const sharedTodoState: { current: TodoState } = { current: { items: new Map() } };
export const todoTool = createTodoTool(sharedTodoState);
export const todoToolDefinition = createTodoToolDefinition(sharedTodoState);

export function getTodoStateRef(): { current: TodoState } {
	return sharedTodoState;
}
