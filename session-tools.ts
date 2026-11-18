import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ToolItem, ToolSaveMode } from "./items.ts";
import {
	applyToolChange, applyToolOverrides, cacheToolInventory, loadToolItems, readToolPreferences,
	type ToolHost,
} from "./tools.ts";

export type SessionToolsContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted"> & {
	sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch" | "getEntries" | "getSessionId" | "getSessionFile">;
};

const entryType = "pi-config-palette/session-tools";
type Choices = Record<string, boolean>;
interface Snapshot {
	version: 1;
	overrides: Choices;
	inherited: Choices;
}
interface BranchState extends Snapshot {
	identity: string;
	snapshotId?: string;
	snapshotIndex: number;
	systemIndex: number;
	leafId?: string;
	branchIds: Set<string>;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const own = (choices: Choices, name: string): boolean | undefined => Object.hasOwn(choices, name) ? choices[name] : undefined;
const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const choices = (value: unknown): value is Choices => record(value) &&
	Object.entries(value).every(([name, enabled]) => name.trim().length > 0 && typeof enabled === "boolean");

function snapshot(entry: SessionEntry): Snapshot | undefined {
	if (entry.type !== "custom" || entry.customType !== entryType) return undefined;
	const value = entry.data;
	if (!record(value) || value.version !== 1 || !choices(value.overrides) || !choices(value.inherited) ||
		Object.keys(value).length !== 3 || !Object.hasOwn(value, "version") ||
		!Object.hasOwn(value, "overrides") || !Object.hasOwn(value, "inherited") ||
		!Object.keys(value.overrides).every((name) => Object.hasOwn(value.inherited as Choices, name))) {
		throw new Error(`Invalid ${entryType} snapshot at entry "${entry.id}"; expected version 1, boolean overrides and an inherited baseline for every override.`);
	}
	return { version: 1, overrides: { ...value.overrides }, inherited: { ...value.inherited } };
}

/** Branch-local, sparse active-tool choices; these are not tool permissions. */
export class SessionTools {
	private previous?: BranchState;

	// Runtime APIs are not bound while the extension factory is running.
	constructor(private readonly pi: ExtensionAPI) {}

	private branch(ctx: SessionToolsContext): BranchState {
		const manager = ctx.sessionManager;
		const file = manager.getSessionFile();
		const entries = file ? manager.getBranch() : [];
		const identity = JSON.stringify([file ? manager.getSessionId() : undefined, file]);
		let latest: Snapshot = { version: 1, overrides: {}, inherited: {} };
		let snapshotIndex = -1;
		let systemIndex = -1;
		for (const [index, entry] of entries.entries()) {
			const value = snapshot(entry);
			if (value) { latest = value; snapshotIndex = index; }
			if (entry.type === "message" && entry.message.role === "system") systemIndex = index;
		}
		if (file && snapshotIndex < 0 && systemIndex < 0) {
			// Pi leaves the current loadout unchanged at an unrecorded root. A fresh
			// extension (reload/resume) therefore needs durable baselines, not active
			// membership. Off-branch *overrides* must never be imported here.
			const previous = this.previous;
			if (previous?.identity === identity && previous.snapshotId === undefined &&
				(previous.leafId === undefined || entries.some((entry) => entry.id === previous.leafId))) {
				latest.inherited = { ...previous.inherited };
			} else {
				for (const entry of manager.getEntries()) {
					const value = snapshot(entry);
					if (!value) continue;
					for (const [name, enabled] of Object.entries(value.inherited)) {
						if (!Object.hasOwn(latest.inherited, name)) latest.inherited = { ...latest.inherited, [name]: enabled };
					}
				}
			}
		}
		return {
			...latest, identity,
			snapshotId: entries[snapshotIndex]?.id, snapshotIndex, systemIndex,
			leafId: entries.at(-1)?.id, branchIds: new Set(entries.map((entry) => entry.id)),
		};
	}

	private changed(state: BranchState): boolean {
		return !this.previous || this.previous.identity !== state.identity ||
			this.previous.snapshotId !== state.snapshotId ||
			(this.previous.leafId !== undefined && !state.branchIds.has(this.previous.leafId));
	}

	private resets(state: BranchState): Choices {
		if (state.systemIndex < 0) {
			// Only named palette controls are unwound; newly registered and unrelated
			// tools retain their current membership. Never carry memory across sessions.
			return {
				...(this.previous?.identity === state.identity ? this.previous.inherited : {}),
				...state.inherited,
			};
		}
		// Core already restored the target native loadout. A later reset snapshot
		// supersedes an older recorded override; a newer native loadout wins instead.
		return state.snapshotIndex > state.systemIndex ? state.inherited : {};
	}

	private transact(overrides: Choices, persist?: () => void): void {
		const active = new Set(this.pi.getActiveTools());
		const available = new Set(this.pi.getAllTools().filter((tool) => tool.exposure !== "hidden").map((tool) => tool.name));
		const previous = Object.fromEntries(Object.keys(overrides).filter((name) => available.has(name)).map((name) => [name, active.has(name)]));
		try {
			applyToolOverrides(this.pi, overrides);
			persist?.();
		} catch (error) {
			try {
				applyToolOverrides(this.pi, previous);
			} catch (rollbackError) {
				throw new AggregateError([error, rollbackError], `Could not update session tools (${message(error)}) or restore their previous state (${message(rollbackError)}).`);
			}
			throw new Error(`Could not update session tools: ${message(error)}`, { cause: error });
		}
	}

	async restore(ctx: SessionToolsContext, reason: "start" | "tree" | "turn"): Promise<void> {
		const saved = await readToolPreferences();
		const state = this.branch(ctx);
		const reset = reason !== "turn" || this.changed(state) ? this.resets(state) : {};
		this.transact({ ...reset, ...saved, ...state.overrides });
		this.previous = state;
	}

	private savedHost(state: BranchState, saved: Choices): ToolHost {
		const underneath = Object.fromEntries(Object.keys(state.overrides).map((name) => [name, state.inherited[name]]));
		const overrides = { ...(this.changed(state) ? this.resets(state) : {}), ...underneath, ...saved };
		// Cache I/O can yield while another session choice is appended. Keep the
		// runtime snapshot paired with the branch state used to remove its overlay.
		const tools = this.pi.getAllTools();
		const observed = this.pi.getActiveTools();
		return {
			getAllTools: () => tools,
			getActiveTools: () => {
				const active = new Set(observed);
				for (const tool of tools) {
					const enabled = own(overrides, tool.name);
					if (tool.exposure === "hidden" || enabled === undefined) continue;
					if (enabled) active.add(tool.name);
					else active.delete(tool.name);
				}
				return [...active];
			},
			setActiveTools: (names) => this.pi.setActiveTools(names),
		};
	}

	async list(ctx: SessionToolsContext, standalone: boolean, warn?: (message: string) => void): Promise<ToolItem[]> {
		if (standalone) {
			// This path must work even when every session/runtime API throws.
			return (await loadToolItems(this.pi, ctx, true, warn)).map((item) => ({ ...item, savedEnabled: item.enabled }));
		}
		const saved = await readToolPreferences();
		const state = this.branch(ctx);
		const active = new Set(this.pi.getActiveTools());
		const items = await loadToolItems(this.savedHost(state, saved), ctx, false, warn);
		return items.map((item) => ({
			...item, savedEnabled: item.enabled,
			sessionEnabled: item.exposure !== "hidden" && active.has(item.name),
			sessionPreference: own(state.overrides, item.name),
		}));
	}

	async save(ctx: SessionToolsContext, item: ToolItem, mode: ToolSaveMode, standalone: boolean): Promise<ToolItem> {
		if (mode === "session" && (standalone || !ctx.sessionManager.getSessionFile())) {
			throw new Error("Session tool choices require a persisted Pi session and are unavailable in standalone mode.");
		}
		if (standalone) {
			await applyToolChange(this.pi, ctx, item, true);
		} else {
			if (!item.name.trim() || typeof item.desired !== "boolean" || !item.mutable || item.exposure === "hidden") {
				throw new Error(`Tool "${item.name}" cannot be changed.`);
			}
			const saved = await readToolPreferences();
			const state = this.branch(ctx);
			const tool = this.pi.getAllTools().find((entry) => entry.name === item.name);
			if (!tool) throw new Error(`Tool "${item.name}" is not available in the current runtime.`);
			if (tool.exposure === "hidden") throw new Error(`Tool "${item.name}" is hidden and cannot be changed.`);
			if (mode === "saved") {
				// Global persistence/locking/rollback belongs to tools.ts. The session
				// choice continues to win without modifying its snapshot or ledger.
				await applyToolChange(this.pi, ctx, item, false, own(state.overrides, item.name) ?? item.desired);
			} else {
				let inherited = { ...this.resets(state), ...state.inherited };
				const active = new Set(this.pi.getActiveTools());
				// Carry newer native baselines for *all* released keys into the next
				// snapshot, or its later position would revive their obsolete resets.
				// Never recapture a key whose temporary override is still in force.
				if (state.systemIndex > state.snapshotIndex) {
					for (const available of this.pi.getAllTools()) {
						if (available.exposure !== "hidden" && Object.hasOwn(inherited, available.name) &&
							own(state.overrides, available.name) === undefined) {
							inherited = { ...inherited, [available.name]: active.has(available.name) };
						}
					}
				}
				if (!Object.hasOwn(inherited, item.name)) inherited = { ...inherited, [item.name]: active.has(item.name) };
				const overrides = { ...state.overrides, [item.name]: item.desired };
				const underlying = own(saved, item.name) ?? inherited[item.name];
				if (item.desired === underlying) delete overrides[item.name];
				const next: Snapshot = { version: 1, overrides, inherited };
				const changes = this.changed(state)
					? { ...this.resets(state), ...saved, ...overrides, [item.name]: item.desired }
					: { [item.name]: item.desired };
				this.transact(changes, () => this.pi.appendEntry(entryType, next));
				this.previous = this.branch(ctx);
			}
		}
		const fresh = (await this.list(ctx, standalone)).find((entry) => entry.name === item.name);
		if (!fresh) throw new Error(`Tool "${item.name}" is no longer available after saving.`);
		return fresh;
	}

	async cache(ctx: SessionToolsContext): Promise<void> {
		const saved = await readToolPreferences();
		await cacheToolInventory(this.savedHost(this.branch(ctx), saved), ctx);
	}
}
