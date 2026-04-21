/**
 * Utilities for formatting keybinding hints in the UI.
 */

import { getKeybindings, type Keybinding, type KeyId } from "nami-tui";

function formatKeys(keys: KeyId[]): string {
	if (keys.length === 0) return "";
	if (keys.length === 1) return keys[0]!;
	return keys.join("/");
}

export function keyText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding));
}

// Premium color palette
const PINK = "\x1b[38;5;213m"; // Light pink
const HOT_PINK = "\x1b[38;5;198m"; // Hot pink
const GRAY = "\x1b[90m";
const RESET = "\x1b[0m";

// Create a visually stunning key hint with proper boxes
export function keyHint(keybinding: Keybinding, description: string): string {
	const key = keyText(keybinding);

	// Return single line version with box around key
	const box = `${PINK}[${HOT_PINK}${key}${PINK}]${RESET}`;
	return `${box} ${GRAY}${description}${RESET}`;
}

export function rawKeyHint(key: string, description: string): string {
	// Create a beautiful boxed key
	const box = `${PINK}[${HOT_PINK}${key}${PINK}]${RESET}`;
	return `${box} ${GRAY}${description}${RESET}`;
}
