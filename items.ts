import type { ToolExposure } from "@earendil-works/pi-coding-agent";
import type { ResourceItem } from "./resources.ts";

export type ToolSaveMode = "saved" | "session";

export interface ToolItem {
	id: string;
	kind: "tool";
	name: string;
	description: string;
	source: string;
	sourcePath?: string;
	exposure: ToolExposure;
	inventory: "live" | "cached";
	capturedAt?: string;
	savedPreference?: boolean;
	sessionPreference?: boolean;
	savedEnabled?: boolean;
	sessionEnabled?: boolean;
	enabled: boolean;
	desired: boolean;
	mutable: boolean;
}

export type PaletteItem = ResourceItem | ToolItem;
