import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ToolExposure } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import type { ToolItem } from "./items.ts";

export type { ToolItem } from "./items.ts";
export type { ToolExposure } from "@earendil-works/pi-coding-agent";
export type ToolContext = Pick<ExtensionCommandContext, "cwd" | "isProjectTrusted">;
export type ToolHost = Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">;

interface Preferences {
	version: 1;
	overrides: Record<string, boolean>;
}

interface InventoryTool {
	name: string;
	description: string;
	source: string;
	sourcePath?: string;
	exposure: ToolExposure;
	enabled: boolean;
}

interface Inventory {
	version: 1;
	context: { cwd: string; projectTrusted: boolean };
	capturedAt: string;
	tools: InventoryTool[];
}

const exposures = new Set<string>(["direct", "model-only", "codemode", "deferred", "hidden"]);
const preferencesPath = () => path.join(getAgentDir(), "pi-config-palette-tools.json");
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const hasKeys = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
	required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const isName = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

async function readJson(file: string): Promise<unknown> {
	let text: string;
	try {
		text = await fs.readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`Cannot read ${file}: ${message(error)}`, { cause: error });
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`Invalid JSON in ${file}: ${message(error)}`, { cause: error });
	}
}

async function readPreferences(file = preferencesPath()): Promise<Preferences> {
	const value = await readJson(file);
	if (value === undefined) return { version: 1, overrides: {} };
	if (!isRecord(value) || !hasKeys(value, ["version", "overrides"]) || value.version !== 1 ||
		!isRecord(value.overrides) || !Object.entries(value.overrides).every(([name, enabled]) => isName(name) && typeof enabled === "boolean")) {
		throw new Error(`Invalid tool preferences in ${file}; expected version 1 and boolean overrides. File was not changed.`);
	}
	// SAFETY: all required keys, the version, and every override value were validated above.
	return value as unknown as Preferences;
}

export async function readToolPreferences(): Promise<Record<string, boolean>> {
	return { ...(await readPreferences()).overrides };
}

async function atomicWrite(file: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		await fs.rename(temporary, file);
	} finally {
		// A failed rename must leave the previous document intact. Cleanup must not hide its error.
		await fs.rm(temporary, { force: true }).catch(() => {});
	}
}

async function inventoryContext(ctx: ToolContext): Promise<Inventory["context"]> {
	return { cwd: await fs.realpath(ctx.cwd), projectTrusted: ctx.isProjectTrusted() };
}

function inventoryPath(context: Inventory["context"]): string {
	const key = createHash("sha256").update(JSON.stringify(context)).digest("hex");
	return path.join(getAgentDir(), "cache", "pi-config-palette", `${key}.json`);
}

function validInventoryTool(value: unknown): value is InventoryTool {
	return isRecord(value) && hasKeys(value, ["name", "description", "source", "exposure", "enabled"], ["sourcePath"]) &&
		isName(value.name) && typeof value.description === "string" && isName(value.source) &&
		(!Object.hasOwn(value, "sourcePath") || typeof value.sourcePath === "string") &&
		typeof value.exposure === "string" && exposures.has(value.exposure) && typeof value.enabled === "boolean" &&
		(value.exposure !== "hidden" || value.enabled === false);
}

async function readInventory(ctx: ToolContext): Promise<Inventory | undefined> {
	const context = await inventoryContext(ctx);
	const file = inventoryPath(context);
	const value = await readJson(file);
	if (value === undefined) return undefined;
	if (!isRecord(value) || !hasKeys(value, ["version", "context", "capturedAt", "tools"]) || value.version !== 1 ||
		!isRecord(value.context) || !hasKeys(value.context, ["cwd", "projectTrusted"]) ||
		value.context.cwd !== context.cwd || value.context.projectTrusted !== context.projectTrusted ||
		typeof value.capturedAt !== "string" || !Number.isFinite(Date.parse(value.capturedAt)) ||
		!Array.isArray(value.tools) || !value.tools.every(validInventoryTool) ||
		new Set(value.tools.map((tool) => tool.name)).size !== value.tools.length) {
		throw new Error(`Invalid tool inventory in ${file}; expected version 1 for this project and trust state. Refresh it inside Pi.`);
	}
	// SAFETY: the complete envelope, matching context, and every whitelisted tool were validated above.
	return value as unknown as Inventory;
}

async function captureInventory(pi: ToolHost, ctx: ToolContext): Promise<Inventory> {
	const context = await inventoryContext(ctx);
	const active = new Set(pi.getActiveTools());
	// Whitelist metadata: schemas, functions, and extension-owned objects never enter the cache.
	const tools: InventoryTool[] = pi.getAllTools().map((tool) => ({
		name: tool.name,
		description: tool.description,
		source: tool.sourceInfo.source,
		sourcePath: tool.sourceInfo.path,
		exposure: tool.exposure,
		enabled: tool.exposure !== "hidden" && active.has(tool.name),
	})).sort((a, b) => a.name.localeCompare(b.name));
	return { version: 1, context, capturedAt: new Date().toISOString(), tools };
}

export async function cacheToolInventory(pi: ToolHost, ctx: ToolContext): Promise<void> {
	const inventory = await captureInventory(pi, ctx);
	await atomicWrite(inventoryPath(inventory.context), inventory);
}

export async function loadToolItems(
	pi: ToolHost, ctx: ToolContext, standalone: boolean, warn?: (message: string) => void,
): Promise<ToolItem[]> {
	const preferences = await readPreferences();
	const inventory = standalone ? await readInventory(ctx) : await captureInventory(pi, ctx);
	if (!inventory) return [];
	if (!standalone) {
		try {
			await atomicWrite(inventoryPath(inventory.context), inventory);
		} catch (error) {
			warn?.(`Could not cache tool inventory: ${message(error)}`);
		}
	}
	return inventory.tools.map((tool): ToolItem => {
		const savedPreference = Object.hasOwn(preferences.overrides, tool.name) ? preferences.overrides[tool.name] : undefined;
		const enabled = tool.exposure !== "hidden" && (standalone ? savedPreference ?? tool.enabled : tool.enabled);
		return {
			...tool, id: `tool:${tool.name}`, kind: "tool", enabled, desired: enabled,
			mutable: tool.exposure !== "hidden", inventory: standalone ? "cached" : "live",
			capturedAt: inventory.capturedAt, ...(savedPreference === undefined ? {} : { savedPreference }),
		};
	}).sort((a, b) => a.name.localeCompare(b.name));
}

function setMembership(pi: ToolHost, name: string, enabled: boolean): void {
	const active = pi.getActiveTools();
	if (active.includes(name) === enabled) return;
	pi.setActiveTools(enabled ? [...active, name] : active.filter((entry) => entry !== name));
	if (pi.getActiveTools().includes(name) !== enabled) {
		throw new Error(`Pi did not ${enabled ? "activate" : "deactivate"} tool "${name}"; its current configuration may not support this change.`);
	}
}

export async function applyToolChange(pi: ToolHost, ctx: ToolContext, item: ToolItem, standalone: boolean, runtimeDesired = item.desired): Promise<void> {
	if (!isName(item.name) || typeof item.desired !== "boolean" || !item.mutable || item.exposure === "hidden") {
		throw new Error(`Tool "${item.name}" cannot be changed.`);
	}
	// Resolve directory symlinks so cooperating sessions share the same lock, even on first write.
	await fs.mkdir(getAgentDir(), { recursive: true });
	const file = path.join(await fs.realpath(getAgentDir()), "pi-config-palette-tools.json");
	const release = await lockfile.lock(file, {
		realpath: false,
		retries: { retries: 30, factor: 1.2, minTimeout: 10, maxTimeout: 100 },
	});
	try {
		const preferences = await readPreferences(file);
		const tool = standalone
			? (await readInventory(ctx))?.tools.find((entry) => entry.name === item.name)
			: pi.getAllTools().find((entry) => entry.name === item.name);
		if (!tool) throw new Error(`Tool "${item.name}" is not available in the ${standalone ? "cached inventory; refresh it inside Pi" : "current runtime"}.`);
		if (tool.exposure === "hidden") throw new Error(`Tool "${item.name}" is hidden and cannot be changed.`);
		const previous = standalone ? undefined : pi.getActiveTools().includes(item.name);
		try {
			if (!standalone) setMembership(pi, item.name, runtimeDesired);
			await atomicWrite(file, { version: 1, overrides: { ...preferences.overrides, [item.name]: item.desired } });
		} catch (error) {
			if (previous !== undefined) {
				try {
					// Restore this choice only: another extension may have changed unrelated tools meanwhile.
					setMembership(pi, item.name, previous);
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], `Could not save tool "${item.name}" (${message(error)}) or restore its previous state (${message(rollbackError)}).`);
				}
			}
			throw new Error(`Could not save tool "${item.name}": ${message(error)}`, { cause: error });
		}
	} finally {
		await release();
	}
}

/**
 * Cooperative active-selection preferences, not permission enforcement. Deferred/codemode tools
 * remain callable, and activation tools or later extension handlers can change the set again.
 */
export async function restoreToolPreferences(pi: ToolHost): Promise<void> {
	applyToolOverrides(pi, await readToolPreferences());
}

export function applyToolOverrides(pi: ToolHost, overrides: Record<string, boolean>): void {
	if (Object.keys(overrides).length === 0) return;
	const available = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
	const active = pi.getActiveTools();
	const desired = new Set(active);
	const applicable = Object.entries(overrides).filter(([name]) => {
		const tool = available.get(name);
		return tool !== undefined && tool.exposure !== "hidden";
	});
	for (const [name, enabled] of applicable) {
		if (enabled) desired.add(name);
		else desired.delete(name);
	}
	if (desired.size === active.length && active.every((name) => desired.has(name))) return;
	pi.setActiveTools([...desired]);
	const applied = new Set(pi.getActiveTools());
	for (const [name, enabled] of applicable) {
		if (applied.has(name) !== enabled) throw new Error(`Pi did not restore the saved active state of tool "${name}".`);
	}
}
