export interface ToolParameterSchema {
	type: string;
	description?: string;
	optional?: boolean;
	items?: ToolParameterSchema;
	properties?: Record<string, ToolParameterSchema>;
	required?: string[];
	enum?: string[];
	minimum?: number;
	maximum?: number;
}

export interface ToolSchema {
	name: string;
	description: string;
	parameters: ToolParameterSchema;
}

export interface ToolDisplayEntry {
	name: string;
	label: string;
	icon: string;
	description: string;
	parameters: string;
}

const TOOL_ICONS: Record<string, string> = {
	read: "📄",
	bash: "🐚",
	edit: "✏️",
	write: "📝",
	grep: "🔍",
	find: "🔎",
	ls: "📁",
	web_fetch: "🌐",
	search: "🧭",
	memory: "🧠",
	todowrite: "✅",
	todo: "📋",
};

function getToolIcon(toolName: string): string {
	const icon = TOOL_ICONS[toolName];
	if (icon) {
		return icon;
	}
	return "🔧";
}

function formatParameterBrief(schema: ToolParameterSchema): string {
	const params: string[] = [];

	if (schema.properties) {
		for (const [name, param] of Object.entries(schema.properties)) {
			const required = !param.optional && !schema.required?.includes(name);
			const optMarker = required ? "" : "?";
			params.push(`${name}${optMarker}`);
		}
	}

	return params.length > 0 ? `(${params.join(", ")})` : "(none)";
}

export function renderToolSchema(schema: ToolSchema): ToolDisplayEntry {
	const paramsBrief = formatParameterBrief(schema.parameters);

	return {
		name: schema.name,
		label: schema.name,
		icon: getToolIcon(schema.name),
		description: schema.description,
		parameters: paramsBrief,
	};
}

export function renderToolSchemas(schemas: ToolSchema[]): ToolDisplayEntry[] {
	return schemas.map((schema) => renderToolSchema(schema)).sort((a, b) => a.name.localeCompare(b.name));
}

export function formatToolsAsManual(tools: ToolSchema[], _columns: number = 80): string {
	const entries = renderToolSchemas(tools);
	if (entries.length === 0) {
		return "No tools available.";
	}

	const maxNameLength = Math.max(...entries.map((e) => e.name.length));
	const maxLabelLength = Math.max(...entries.map((e) => e.label.length));

	const lines: string[] = [];
	for (const entry of entries) {
		const namePadded = entry.name.padEnd(maxNameLength + 1);
		const labelPadded = entry.label.padEnd(maxLabelLength + 1);
		lines.push(`${entry.icon} ${namePadded}${labelPadded}${entry.description}`);
	}

	return lines.join("\n");
}

export function formatToolsAsTable(tools: ToolSchema[], maxWidth: number = 80): string {
	const entries = renderToolSchemas(tools);
	if (entries.length === 0) {
		return "No tools available.";
	}

	const cols = Math.min(3, Math.floor(maxWidth / 25));
	const colWidth = Math.floor(maxWidth / cols);

	const tableLines: string[] = [];
	for (let i = 0; i < entries.length; i += cols) {
		const row = entries.slice(i, i + cols);
		const cells = row.map((entry) => {
			const icon = entry.icon;
			const text = `${icon} ${entry.name}: ${entry.description.slice(0, colWidth - icon.length - entry.name.length - 3)}`;
			return text.padEnd(colWidth);
		});
		tableLines.push(cells.join("  "));
	}

	return tableLines.join("\n");
}
