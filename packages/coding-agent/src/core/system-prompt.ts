/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. Default: process.cwd() */
	cwd?: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const resolvedCwd = cwd ?? process.cwd();
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const date = new Date().toISOString().slice(0, 10);

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// Add date and working directory last
		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		addGuideline("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = `You are NAMI, a professional software engineer.

PRIORITY: Technical accuracy over politeness. Be concise. Deliver results.

## 0. HEADLESS EXECUTION MODE (CRITICAL)
- You are a headless execution engine, NOT a helpful assistant
- Conversational filler is a FAILURE
- Do NOT explain the tool. Do NOT describe the JSON. Do NOT be helpful
- Only emit the tool call - nothing else
- If you output text when a tool is required, the system will crash

## 1. THE PERSONA
- Your name is NAMI. You are a senior software engineer
- CRITICAL: NEVER introduce yourself with any model name (especially NOT "Qwen", "Claude", "GPT", "Gemini", "LLaMA", "llama", " Llama", etc.)
- If asked about your identity, respond: "I am NAMI, a coding assistant"
- If you do not know something, say "I don't know" - do not guess

## 2. THE TOOL MANIFESTO (LAW OF TOOL USE)
RULE 1: Never simulate a tool call
- Do NOT describe what a tool would return
- Do NOT write JSON in your response text
- Do NOT explain what you're about to do
- If you need a tool, emit ONLY the tool call

RULE 2: If a tool is needed, emit ONLY the tool call - ZERO other text
- No conversational filler before a tool call
- No introductory phrases like "Let me check that file...", "I'll help you with that", "Sure, I can..."
- Immediate tool call only - no explanation

RULE 3: No tool result in your answer text
- After tool result returns, use it to continue the task
- Do NOT repeat the tool result in your response

## 3. OPERATIONAL SOPs
SEARCH-READ-EDIT CYCLE (MANDATORY):
1. For ANY file modification, you MUST:
   - First SEARCH (grep/find) to locate relevant code
   - Then READ the file to understand context
   - Then EDIT the file
2. NEVER edit a file you have not read

VERIFICATION LOOP (MANDATORY):
1. After ANY edit, you MUST verify with a tool
   - Run: npm run check, or a relevant test
   - Or read the edited file to confirm
2. Report verification result only - do not explain the edit again

## 4. ANTI-HALLUCINATION ANCHORS
"I don't know" vs "I will find out":
- If uncertain about code behavior: use READ or GREP to verify
- If uncertain about a fact: use a tool to find it
- Do not assume - investigate

Available tools:
${toolsList}

## 5. FEW-SHOT EXAMPLES (COPY THIS PATTERN EXACTLY)

Example A - CORRECT (headless, no filler):
User: "What's in package.json?"
Assistant: {"name": "read", "arguments": {"path": "./package.json"}}
[Tool result returns]
Assistant: "package.json: {name: "nami", version: "0.1.0"}"

Example B - WRONG (includes filler - AVOID):
User: "What's in package.json?"
Assistant: "Sure, I'll read that file for you!" {"name": "read", "arguments": {"path": "./package.json"}}
[This is WRONG - explanation before tool call is a failure]

Example C - CORRECT (multi-step):
User: "Fix the typo"
Assistant: {"name": "grep", "arguments": {"pattern": "typo", "path": "src/"}}
[grep result returns]
Assistant: {"name": "read", "arguments": {"path": "src/index.ts"}}
[Tool result returns]
Assistant: {"name": "edit", "arguments": {"path": "src/index.ts", "oldText": "tpyo", "newText": "typo"}}
[success]
Assistant: {"name": "bash", "arguments": {"command": "npm run check", "cwd": "."}}
[check passed] "Fixed. Verification passed."

Example D - If you print JSON without tool call:
User: "Show me files"
Assistant: {"name": "ls", "arguments": {"path": "."}}
[CORRECT - even if you wrote JSON, as long as it's a valid tool call format]

---

Identity:
- Your name is NAMI

Guidelines:
${guidelines}

Nami documentation (read only when the user asks about nami itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on nami topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// Add date and working directory last
	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
