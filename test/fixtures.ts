import { Theme } from "@earendil-works/pi-coding-agent";
import type { ResourceItem } from "../resources.ts";
import type { ToolItem } from "../items.ts";

// Only the tokens used by this component (and required theme fallbacks).
export const theme = new Theme({
	accent: "#ffc799", borderMuted: "#303030", text: "#fefefe",
	muted: "#a0a0a0", dim: "#6b6b6b", warning: "#f2ca7d", error: "#f28779", success: "#a8cc8c", thinkingXhigh: "#ffc799",
} as ConstructorParameters<typeof Theme>[0], {
	selectedBg: "#1b1b1b",
} as ConstructorParameters<typeof Theme>[1], "truecolor");

export function tool(name: string, overrides: Partial<ToolItem> = {}): ToolItem {
	return {
		id: `tool:${name}`, kind: "tool", name, description: `Tool for ${name}`,
		source: "builtin", exposure: "direct", inventory: "live",
		enabled: true, desired: true, mutable: true, ...overrides,
	};
}

export function resource(name: string, overrides: Partial<ResourceItem> = {}): ResourceItem {
	return {
		id: name, kind: "skill", key: "skills", name,
		description: `Instructions for ${name}`,
		path: `/test/skills/${name}/SKILL.md`, relativePath: `skills/${name}/SKILL.md`,
		source: "local", scope: "user", origin: "top-level", baseDir: "/test",
		enabled: true, desired: true, mutable: true, ...overrides,
	};
}
