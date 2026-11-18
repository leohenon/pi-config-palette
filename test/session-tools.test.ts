import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import {
	createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, SessionManager, SettingsManager,
	type CreateAgentSessionRuntimeFactory, type ExtensionAPI, type ToolExposure, type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { ToolItem } from "../items.ts";
import { SessionTools, type SessionToolsContext } from "../session-tools.ts";
import type { ToolHost } from "../tools.ts";

const entryType = "pi-config-palette/session-tools";
const state = (overrides: Record<string, boolean>, inherited: Record<string, boolean>) => ({ version: 1, overrides, inherited });

function tool(name: string, exposure: ToolExposure = "direct"): ToolInfo {
	return {
		name, exposure, description: `Description of ${name}`, parameters: { type: "object" },
		sourceInfo: { source: "local", path: `/extensions/${name}.ts`, scope: "user", origin: "top-level" },
	};
}

class Host implements ToolHost {
	tools = [tool("read"), tool("write"), tool("other")];
	active = new Set(["read", "write", "other"]);
	calls: string[][] = [];
	onSet?: (names: string[]) => void;
	onAppend?: () => void;
	constructor(public manager: SessionManager) {}
	getAllTools() { return this.tools; }
	getActiveTools() { return [...this.active]; }
	setActiveTools(names: string[]) {
		this.calls.push([...names]);
		if (this.onSet) return this.onSet(names);
		this.active = new Set(names.filter((name) => this.tools.some((entry) => entry.name === name && entry.exposure !== "hidden")));
	}
	appendEntry<T>(customType: string, data: T): void {
		this.onAppend?.();
		this.manager.appendCustomEntry(customType, data);
	}
	controller() { return new SessionTools(this as unknown as ExtensionAPI); }
}

async function fixture(t: TestContext) {
	const root = await fs.mkdtemp(path.join(tmpdir(), "pi-palette-session-tools-"));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	await fs.mkdir(agentDir);
	await fs.mkdir(cwd);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(async () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await fs.rm(root, { recursive: true, force: true });
	});
	const preferences = path.join(agentDir, "pi-config-palette-tools.json");
	const sessions = path.join(root, "sessions");
	const manager = SessionManager.create(cwd, sessions);
	const rootId = manager.appendMessage({ role: "user", content: "test", timestamp: Date.now() });
	const ctx: SessionToolsContext = { cwd, isProjectTrusted: () => true, sessionManager: manager };
	const pi = new Host(manager);
	return {
		root, agentDir, cwd, preferences, sessions, manager, rootId, ctx, pi, controller: pi.controller(),
		writePreferences: (overrides: Record<string, boolean>) => fs.writeFile(preferences, JSON.stringify({ version: 1, overrides })),
		readPreferences: async () => JSON.parse(await fs.readFile(preferences, "utf8")),
		cacheFiles: async () => {
			const dir = path.join(agentDir, "cache", "pi-config-palette");
			return (await fs.readdir(dir)).map((name) => path.join(dir, name));
		},
	};
}

function row(items: ToolItem[], name = "read", desired?: boolean): ToolItem {
	const item = items.find((entry) => entry.name === name);
	assert.ok(item, `Missing tool ${name}`);
	return { ...item, desired: desired ?? item.desired };
}

async function save(f: Awaited<ReturnType<typeof fixture>>, name: string, desired: boolean, mode: "saved" | "session" = "session") {
	return f.controller.save(f.ctx, row(await f.controller.list(f.ctx, false), name, desired), mode, false);
}

function snapshot(manager: SessionManager) {
	const entries = manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === entryType);
	const latest = entries.at(-1);
	assert.ok(latest?.type === "custom");
	return latest.data as ReturnType<typeof state>;
}

function system(manager: SessionManager, names: string[]) {
	return manager.appendMessage({
		role: "system", content: "", timestamp: Date.now(),
		toolsAdded: names.map((name) => ({ name, description: name, parameters: { type: "object" } })),
	});
}

async function absent(file: string) {
	await assert.rejects(fs.access(file), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
}

const noRuntime = new Proxy({} as ExtensionAPI, {
	get(_target, property) { throw new Error(`Unexpected runtime access: ${String(property)}`); },
});
const noSession = new Proxy({} as SessionToolsContext["sessionManager"], {
	get(_target, property) { throw new Error(`Unexpected session access: ${String(property)}`); },
});

test("construction makes no runtime calls; standalone listing is cache-only", async (t) => {
	const f = await fixture(t);
	const controller = new SessionTools(noRuntime);
	const ctx = { ...f.ctx, sessionManager: noSession };
	assert.deepEqual(await controller.list(ctx, true), []);
	await f.controller.cache(f.ctx);
	const [file] = await f.cacheFiles();
	const before = await fs.readFile(file, "utf8");
	const items = await controller.list(ctx, true);
	assert.equal(items.length, 3);
	assert.ok(items.every((item) => item.inventory === "cached" && item.sessionEnabled === undefined));
	assert.equal(await fs.readFile(file, "utf8"), before);
	await assert.rejects(controller.save(ctx, row(items, "read", false), "session", true), /persisted Pi session/);
	const updated = await controller.save(ctx, row(items, "read", false), "saved", true);
	assert.equal(updated.savedEnabled, false);
	assert.equal(updated.enabled, false);
	assert.equal(await fs.readFile(file, "utf8"), before);
});

test("false is a real preference at both layers and session choices remain sparse", async (t) => {
	const f = await fixture(t);
	await f.writePreferences({ read: false, write: true });
	await f.controller.restore(f.ctx, "start");
	assert.equal(f.pi.active.has("read"), false);
	const read = await save(f, "read", true);
	assert.equal(read.savedEnabled, false);
	assert.equal(read.enabled, false);
	assert.equal(read.desired, false);
	assert.equal(read.sessionEnabled, true);
	assert.equal(read.sessionPreference, true);
	const write = await save(f, "write", false);
	assert.equal(write.savedEnabled, true);
	assert.equal(write.sessionEnabled, false);
	assert.equal(write.sessionPreference, false);
	f.pi.active = new Set(["write", "other"]);
	await f.controller.restore(f.ctx, "turn");
	assert.deepEqual([...f.pi.active].sort(), ["other", "read"]);
	assert.deepEqual(snapshot(f.manager), state({ read: true, write: false }, { read: false, write: true }));
});

test("Saved edits under a Session override update only global state and return both views", async (t) => {
	const f = await fixture(t);
	await save(f, "read", false);
	const count = f.manager.getEntries().length;
	const original = snapshot(f.manager);
	let updated = await save(f, "read", false, "saved");
	assert.equal(updated.savedPreference, false);
	assert.equal(updated.sessionPreference, false, "equal Saved values must not clear the temporary override");
	updated = await save(f, "read", true, "saved");
	assert.equal(updated.enabled, true);
	assert.equal(updated.savedEnabled, true);
	assert.equal(updated.sessionEnabled, false);
	assert.equal(updated.sessionPreference, false);
	assert.equal(f.pi.active.has("read"), false);
	assert.deepEqual(snapshot(f.manager), original);
	assert.equal(f.manager.getEntries().length, count);
	assert.deepEqual(await f.readPreferences(), { version: 1, overrides: { read: true } });
});

test("clearing a Session choice retains its inherited ledger and never recaptures the override", async (t) => {
	const f = await fixture(t);
	await save(f, "read", false);
	let updated = await save(f, "read", true);
	assert.equal(updated.sessionPreference, undefined);
	assert.equal(updated.sessionEnabled, true);
	assert.deepEqual(snapshot(f.manager), state({}, { read: true }));
	await save(f, "read", false);
	f.controller = f.pi.controller(); // /reload retains the disabled runtime.
	await f.controller.restore(f.ctx, "start");
	updated = await save(f, "read", true);
	assert.equal(updated.sessionPreference, undefined);
	assert.deepEqual(snapshot(f.manager), state({}, { read: true }));
	await absent(f.preferences);
});

test("clearing compares with fresh saved preferences, not the preference at override creation", async (t) => {
	const f = await fixture(t);
	await save(f, "read", false);
	await f.writePreferences({ read: false });
	const updated = await save(f, "read", false);
	assert.equal(updated.sessionPreference, undefined);
	assert.equal(updated.savedEnabled, false);
	assert.deepEqual(snapshot(f.manager), state({}, { read: true }));
	f.pi.active.add("read");
	await f.pi.controller().restore(f.ctx, "start");
	assert.equal(f.pi.active.has("read"), false, "Saved false must win over the true reset baseline");
});

test("Session saves never create or rewrite global preferences/settings", async (t) => {
	const f = await fixture(t);
	const settings = path.join(f.agentDir, "settings.json");
	await fs.writeFile(settings, "{\"untouched\": true}\n");
	await save(f, "read", false);
	await absent(f.preferences);
	await f.writePreferences({ other: false });
	const before = await fs.readFile(f.preferences, "utf8");
	await save(f, "read", true);
	await f.controller.cache(f.ctx);
	assert.equal(await fs.readFile(f.preferences, "utf8"), before);
	assert.equal(await fs.readFile(settings, "utf8"), "{\"untouched\": true}\n");
	assert.equal(f.manager.buildSessionContext().messages.some((entry) => "customType" in entry && entry.customType === entryType), false);
});

test("cold resume replays snapshots from the persisted branch and can clear back to inherit", async (t) => {
	const f = await fixture(t);
	await save(f, "read", false);
	const reopened = SessionManager.open(f.manager.getSessionFile()!);
	f.ctx = { ...f.ctx, sessionManager: reopened };
	f.pi.manager = reopened;
	f.manager = reopened;
	f.controller = f.pi.controller();
	await f.controller.restore(f.ctx, "start");
	assert.equal(f.pi.active.has("read"), false);
	await save(f, "read", true);
	assert.deepEqual(snapshot(reopened), state({}, { read: true }));
});

test("a reset after a recorded overridden loadout unwinds stale native state on cold resume", async (t) => {
	const f = await fixture(t);
	await save(f, "read", false);
	system(f.manager, ["write", "other"]);
	await save(f, "read", true);
	f.pi.active.delete("read"); // Core's transcript restore predates the reset snapshot.
	await f.pi.controller().restore(f.ctx, "start");
	assert.equal(f.pi.active.has("read"), true);
	assert.deepEqual(snapshot(f.manager), state({}, { read: true }));
});

test("a newer native loadout after a reset is respected, including by Saved/cache views", async (t) => {
	const f = await fixture(t);
	await save(f, "read", false);
	await save(f, "read", true);
	system(f.manager, ["write", "other"]);
	f.pi.active.delete("read");
	f.controller = f.pi.controller();
	await f.controller.restore(f.ctx, "start");
	assert.equal(f.pi.active.has("read"), false);
	assert.equal(row(await f.controller.list(f.ctx, false)).savedEnabled, false);
	await f.controller.cache(f.ctx);
	assert.equal(row(await new SessionTools(noRuntime).list({ ...f.ctx, sessionManager: noSession }, true)).enabled, false);
	await save(f, "read", true);
	assert.deepEqual(snapshot(f.manager), state({ read: true }, { read: false }));
	await save(f, "read", false);
	assert.deepEqual(snapshot(f.manager), state({}, { read: false }));
});

test("inherited resets run on boundaries, not each turn; explicit choices still reapply", async (t) => {
	const f = await fixture(t);
	await save(f, "read", false);
	await save(f, "read", true);
	await save(f, "write", false);
	await f.writePreferences({ other: false });
	f.pi.active = new Set(["write", "other"]);
	f.manager.appendMessage({ role: "user", content: "next", timestamp: Date.now() });
	await f.controller.restore(f.ctx, "turn");
	assert.deepEqual([...f.pi.active], [], "released read must not be forced back on every turn");
	assert.equal(row(await f.controller.list(f.ctx, false)).savedEnabled, false);
	await f.controller.restore(f.ctx, "start");
	assert.deepEqual([...f.pi.active], ["read"]);
});

test("root navigation without system messages unwinds overrides without resetting unrelated tools", async (t) => {
	const f = await fixture(t);
	await save(f, "read", false);
	f.pi.active.delete("other");
	f.pi.tools.push(tool("late"));
	f.pi.active.add("late");
	f.manager.branch(f.rootId);
	await f.controller.restore(f.ctx, "tree");
	assert.deepEqual([...f.pi.active].sort(), ["late", "read", "write"]);
	assert.equal(row(await f.controller.list(f.ctx, false)).sessionPreference, undefined);
	assert.equal(f.manager.getLeafId(), f.rootId, "restoration must not move the user's tree selection");
});

test("cold reload at an unrecorded root uses only off-branch baselines, never off-branch overrides", async (t) => {
	const f = await fixture(t);
	await save(f, "read", false);
	f.manager.resetLeaf();
	f.controller = f.pi.controller();
	await f.controller.restore(f.ctx, "start");
	assert.equal(f.pi.active.has("read"), true);
	assert.equal(row(await f.controller.list(f.ctx, false)).sessionPreference, undefined);
	f.pi.active.delete("read");
	await f.writePreferences({ read: false });
	await f.pi.controller().restore(f.ctx, "start");
	assert.equal(f.pi.active.has("read"), false, "fresh global preferences beat recovered inherited state");
});

test("no-system sibling branches reconcile previous and target controls by name", async (t) => {
	const f = await fixture(t);
	await save(f, "read", false);
	const a = f.manager.getLeafId()!;
	f.manager.branch(f.rootId);
	await f.controller.restore(f.ctx, "tree");
	await save(f, "write", false);
	const b = f.manager.getLeafId()!;
	assert.equal(f.pi.active.has("read"), true);
	f.manager.branch(a);
	await f.controller.restore(f.ctx, "tree");
	assert.equal(f.pi.active.has("read"), false);
	assert.equal(f.pi.active.has("write"), true);
	f.manager.branch(b);
	await f.controller.restore(f.ctx, "tree");
	assert.equal(f.pi.active.has("read"), true);
	assert.equal(f.pi.active.has("write"), false);
});

test("target system messages supersede disappearing palette controls on native sibling branches", async (t) => {
	const f = await fixture(t);
	await save(f, "read", false);
	const a = f.manager.getLeafId()!;
	f.manager.branch(f.rootId);
	const b = system(f.manager, ["write"]);
	f.pi.active = new Set(["write"]); // Native target restoration happens before session_tree.
	await f.controller.restore(f.ctx, "tree");
	assert.deepEqual([...f.pi.active], ["write"], "do not restore read's old true inherited value");
	assert.equal(row(await f.controller.list(f.ctx, false)).sessionPreference, undefined);
	f.manager.branch(a);
	await f.controller.restore(f.ctx, "tree");
	assert.equal(f.pi.active.has("read"), false);
	f.manager.branch(b);
	f.pi.active = new Set(["write"]);
	await f.pi.controller().restore(f.ctx, "start");
	assert.deepEqual([...f.pi.active], ["write"]);
});

test("branch reconstruction includes snapshots before compaction, not compacted context only", async (t) => {
	const f = await fixture(t);
	await save(f, "read", false);
	system(f.manager, ["write", "other"]);
	f.manager.appendCompaction("summary", null, 100);
	f.pi.active.add("read");
	await f.pi.controller().restore(f.ctx, "start");
	assert.equal(f.pi.active.has("read"), false);
	assert.equal(row(await f.controller.list(f.ctx, false)).sessionPreference, false);
});

test("new sessions discard controller memory; forks inherit their copied branch snapshots", async (t) => {
	const f = await fixture(t);
	await save(f, "read", false);
	const originalFile = f.manager.getSessionFile()!;
	const fresh = SessionManager.create(f.cwd, f.sessions);
	f.pi.manager = fresh;
	const freshCtx = { ...f.ctx, sessionManager: fresh };
	await f.controller.restore(freshCtx, "start");
	assert.equal(f.pi.active.has("read"), false, "new native state must not be reset using another session's inherited ledger");
	assert.equal(row(await f.controller.list(freshCtx, false)).sessionPreference, undefined);
	const fork = SessionManager.forkFrom(originalFile, f.cwd, f.sessions);
	f.pi.manager = fork;
	f.pi.active.add("read");
	const forkCtx = { ...f.ctx, sessionManager: fork };
	await f.controller.restore(forkCtx, "start");
	assert.equal(f.pi.active.has("read"), false);
	assert.equal(row(await f.controller.list(forkCtx, false)).sessionPreference, false);
	await f.controller.save(forkCtx, row(await f.controller.list(forkCtx, false), "read", true), "session", false);
	assert.deepEqual(snapshot(fork), state({}, { read: true }));
	assert.deepEqual(snapshot(f.manager), state({ read: false }, { read: true }));
});

test("ephemeral contexts use only globals and reject Session saves", async (t) => {
	const f = await fixture(t);
	await save(f, "read", false);
	await f.writePreferences({ read: true });
	const ctx = { ...f.ctx, sessionManager: new Proxy(noSession, {
		get(target, property) { return property === "getSessionFile" ? () => undefined : Reflect.get(target, property); },
	}) };
	await f.controller.restore(ctx, "start");
	assert.equal(f.pi.active.has("read"), true);
	const items = await f.controller.list(ctx, false);
	assert.equal(row(items).sessionPreference, undefined);
	await f.controller.cache(ctx);
	await assert.rejects(f.controller.save(ctx, row(items, "read", false), "session", false), /persisted Pi session/);
	const updated = await f.controller.save(ctx, row(items, "read", false), "saved", false);
	assert.equal(updated.savedEnabled, false);
	assert.equal(updated.sessionEnabled, false);
});

test("hidden/unknown overrides are retained but ignored until a non-hidden tool is available", async (t) => {
	const f = await fixture(t);
	f.pi.tools.push(tool("hidden", "hidden"));
	f.manager.appendCustomEntry(entryType, state({ hidden: true, missing: true, read: false }, { hidden: false, missing: false, read: true }));
	await f.controller.restore(f.ctx, "start");
	assert.deepEqual([...f.pi.active].sort(), ["other", "write"]);
	const items = await f.controller.list(f.ctx, false);
	assert.equal(row(items, "hidden").enabled, false);
	assert.equal(row(items, "hidden").sessionEnabled, false);
	assert.equal(row(items, "hidden").mutable, false);
	await assert.rejects(f.controller.save(f.ctx, row(items, "hidden", true), "session", false), /cannot be changed/);
	f.pi.tools.push(tool("missing", "deferred"));
	await f.controller.restore(f.ctx, "turn");
	assert.equal(f.pi.active.has("missing"), true);
	assert.deepEqual(snapshot(f.manager).overrides, { hidden: true, missing: true, read: false });
});

test("Session save validates current registration/exposure, not a stale item", async (t) => {
	const f = await fixture(t);
	const item = row(await f.controller.list(f.ctx, false), "read", false);
	f.pi.tools = f.pi.tools.filter((entry) => entry.name !== "read");
	await assert.rejects(f.controller.save(f.ctx, item, "session", false), /not available/);
	f.pi.tools.push(tool("read", "hidden"));
	await assert.rejects(f.controller.save(f.ctx, item, "session", false), /hidden/);
	assert.equal(f.pi.calls.length, 0);
	assert.equal(f.manager.getEntries().length, 1);
	await absent(f.preferences);
});

test("malformed matching snapshots fail before any partial application; unrelated entries are ignored", async (t) => {
	const f = await fixture(t);
	f.manager.appendCustomEntry("unrelated", { version: "broken" });
	await f.controller.restore(f.ctx, "start");
	const item = row(await f.controller.list(f.ctx, false), "write", false);
	const malformed = [null, [], {}, { version: 2, overrides: {}, inherited: {} },
		{ version: 1, overrides: { read: "false" }, inherited: { read: true } },
		{ version: 1, overrides: {}, inherited: [] },
		{ version: 1, overrides: {}, inherited: { read: "true" } },
		state({ read: false }, {}), state({ "": false }, { "": true }),
		{ ...state({}, {}), extra: true }];
	for (const value of malformed) {
		f.manager.branch(f.rootId);
		f.manager.appendCustomEntry(entryType, value);
		await assert.rejects(f.controller.restore(f.ctx, "tree"), /Invalid pi-config-palette\/session-tools snapshot/);
		await assert.rejects(f.controller.list(f.ctx, false), /Invalid .*snapshot/);
		await assert.rejects(f.controller.cache(f.ctx), /Invalid .*snapshot/);
		await assert.rejects(f.controller.save(f.ctx, item, "session", false), /Invalid .*snapshot/);
		await assert.rejects(f.controller.save(f.ctx, item, "saved", false), /Invalid .*snapshot/);
	}
	assert.equal(f.pi.calls.length, 0);
	await absent(f.preferences);
});

test("malformed global preferences fail without a runtime change or session append", async (t) => {
	const f = await fixture(t);
	const item = row(await f.controller.list(f.ctx, false), "read", false);
	await fs.writeFile(f.preferences, "{invalid");
	await assert.rejects(f.controller.restore(f.ctx, "start"), /Invalid JSON/);
	await assert.rejects(f.controller.save(f.ctx, item, "session", false), /Invalid JSON/);
	assert.equal(f.pi.calls.length, 0);
	assert.equal(f.manager.getEntries().length, 1);
	assert.equal(await fs.readFile(f.preferences, "utf8"), "{invalid");
});

test("append failure rolls back only the changed tool and does not report success", async (t) => {
	const f = await fixture(t);
	const item = row(await f.controller.list(f.ctx, false), "read", false);
	f.pi.onAppend = () => {
		f.pi.tools.push(tool("late"));
		f.pi.active.add("late");
		f.pi.active.delete("other");
		throw new Error("session disk full");
	};
	await assert.rejects(f.controller.save(f.ctx, item, "session", false), /session disk full/);
	assert.deepEqual([...f.pi.active].sort(), ["late", "read", "write"]);
	assert.equal(f.manager.getEntries().length, 1);
	assert.equal(row(await f.controller.list(f.ctx, false)).sessionPreference, undefined);
	await absent(f.preferences);
	f.pi.onAppend = undefined;
	await f.controller.save(f.ctx, item, "session", false);
	assert.deepEqual(snapshot(f.manager), state({ read: false }, { read: true }));
});

test("silent setter refusal and partial runtime errors never append successful snapshots", async (t) => {
	const f = await fixture(t);
	const item = row(await f.controller.list(f.ctx, false), "read", false);
	f.pi.onSet = () => {};
	await assert.rejects(f.controller.save(f.ctx, item, "session", false), /Pi did not restore/);
	let attempts = 0;
	f.pi.onSet = (names) => {
		f.pi.active = new Set(names);
		f.pi.active.delete("other");
		if (attempts++ === 0) throw new Error("partial setter failure");
	};
	await assert.rejects(f.controller.save(f.ctx, item, "session", false), /partial setter failure/);
	assert.equal(f.pi.active.has("read"), true);
	assert.equal(f.pi.active.has("other"), false);
	assert.equal(f.manager.getEntries().length, 1);
	await absent(f.preferences);
});

test("restore failure rolls back every controlled membership but preserves unrelated runtime changes", async (t) => {
	const f = await fixture(t);
	await f.writePreferences({ read: false, write: false });
	let attempts = 0;
	f.pi.onSet = (names) => {
		f.pi.active = new Set(names);
		f.pi.active.delete("other");
		if (attempts++ === 0) throw new Error("partial restore failure");
	};
	await assert.rejects(f.controller.restore(f.ctx, "start"), /partial restore failure/);
	assert.deepEqual([...f.pi.active].sort(), ["read", "write"]);
	assert.equal(f.manager.getEntries().length, 1);
	f.pi.onSet = undefined;
	await f.controller.restore(f.ctx, "start");
	assert.deepEqual([...f.pi.active], []);
});

test("rollback failure is reported with the persistence error", async (t) => {
	const f = await fixture(t);
	const item = row(await f.controller.list(f.ctx, false), "read", false);
	let attempts = 0;
	f.pi.onSet = (names) => {
		if (attempts++ > 0) throw new Error("rollback refused");
		f.pi.active = new Set(names);
	};
	f.pi.onAppend = () => { throw new Error("session disk full"); };
	await assert.rejects(f.controller.save(f.ctx, item, "session", false), /session disk full.*restore.*rollback refused/);
	assert.equal(f.manager.getEntries().length, 1);
});

test("failed Saved persistence preserves the current Session override and snapshot", async (t) => {
	const f = await fixture(t);
	await save(f, "read", false);
	const original = snapshot(f.manager);
	const count = f.manager.getEntries().length;
	const rename = fs.rename;
	t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
		if (String(args[1]).endsWith("pi-config-palette-tools.json")) throw new Error("global disk full");
		return rename(...args);
	});
	await assert.rejects(save(f, "read", true, "saved"), /global disk full/);
	assert.equal(f.pi.active.has("read"), false);
	assert.equal(f.manager.getEntries().length, count);
	assert.deepEqual(snapshot(f.manager), original);
	await absent(f.preferences);
});

test("list/cache export underlying saved/inherited state, never temporary Session membership", async (t) => {
	const f = await fixture(t);
	f.pi.active.delete("write");
	f.pi.tools.push(tool("hidden", "hidden"));
	await save(f, "read", false);
	await save(f, "write", true);
	const live = await f.controller.list(f.ctx, false);
	assert.equal(row(live, "read").savedEnabled, true);
	assert.equal(row(live, "read").sessionEnabled, false);
	assert.equal(row(live, "write").savedEnabled, false);
	assert.equal(row(live, "write").sessionEnabled, true);
	await f.controller.cache(f.ctx);
	const [file] = await f.cacheFiles();
	const cached = JSON.parse(await fs.readFile(file, "utf8"));
	assert.equal(cached.tools.find((entry: { name: string }) => entry.name === "read").enabled, true);
	assert.equal(cached.tools.find((entry: { name: string }) => entry.name === "write").enabled, false);
	assert.equal(cached.tools.find((entry: { name: string }) => entry.name === "hidden").enabled, false);
	assert.ok(cached.tools.every((entry: object) => !("sessionPreference" in entry) && !("parameters" in entry)));
	const cli = new SessionTools(noRuntime);
	const ctx = { ...f.ctx, sessionManager: noSession };
	assert.equal(row(await cli.list(ctx, true), "read").enabled, true);
	assert.equal(row(await cli.list(ctx, true), "write").enabled, false);
	assert.equal(row(await cli.list(ctx, true), "read").sourcePath, "/extensions/read.ts");
	assert.deepEqual(await cli.list({ ...ctx, isProjectTrusted: () => false }, true), []);
	await absent(f.preferences);
});

test("cache projection also sanitizes a cold unrecorded root before restore has run", async (t) => {
	const f = await fixture(t);
	await save(f, "read", false);
	f.manager.branch(f.rootId);
	const cold = f.pi.controller();
	await cold.cache(f.ctx);
	const cached = await new SessionTools(noRuntime).list({ ...f.ctx, sessionManager: noSession }, true);
	assert.equal(row(cached).enabled, true);
	assert.equal(f.pi.active.has("read"), false, "cache/list must not mutate the observed runtime");
});

test("saving immediately after a cold branch change also reconciles released controls", async (t) => {
	const f = await fixture(t);
	await save(f, "read", false);
	f.manager.branch(f.rootId);
	f.controller = f.pi.controller();
	await save(f, "write", false);
	assert.equal(f.pi.active.has("read"), true);
	assert.equal(f.pi.active.has("write"), false);
	assert.deepEqual(snapshot(f.manager), state({ write: false }, { read: true, write: true }));
	const cached = await new SessionTools(noRuntime).list({ ...f.ctx, sessionManager: noSession }, true);
	assert.equal(row(cached).enabled, true);
});

test("cache-write warnings do not hide live tool state; explicit cache failure rejects", async (t) => {
	const f = await fixture(t);
	await fs.writeFile(path.join(f.agentDir, "cache"), "not a directory");
	const warnings: string[] = [];
	const items = await f.controller.list(f.ctx, false, (warning) => warnings.push(warning));
	assert.equal(items.length, 3);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /Could not cache/);
	await assert.rejects(f.controller.cache(f.ctx));
});

test("prototype-like names are ordinary sparse keys at every layer", async (t) => {
	const f = await fixture(t);
	f.pi.tools = [tool("__proto__"), tool("constructor")];
	f.pi.active.clear();
	await save(f, "__proto__", true);
	await save(f, "constructor", true);
	assert.deepEqual(snapshot(f.manager), state(JSON.parse('{"__proto__":true,"constructor":true}'), JSON.parse('{"__proto__":false,"constructor":false}')));
	f.pi.active.clear();
	await f.pi.controller().restore(f.ctx, "start");
	assert.deepEqual([...f.pi.active].sort(), ["__proto__", "constructor"]);
	await save(f, "__proto__", false);
	assert.equal(Object.hasOwn(snapshot(f.manager).overrides, "__proto__"), false);
	assert.equal(Object.hasOwn(snapshot(f.manager).inherited, "__proto__"), true);
});

test("unchanged turns do not rescan off-branch history for baseline recovery", async (t) => {
	const f = await fixture(t);
	await save(f, "read", false);
	f.manager.branch(f.rootId);
	const reads = t.mock.method(f.manager, "getEntries");
	f.controller = f.pi.controller();
	await f.controller.restore(f.ctx, "start");
	const initial = reads.mock.callCount();
	assert.equal(initial, 1);
	for (let index = 0; index < 3; index++) {
		f.manager.appendMessage({ role: "user", content: `turn ${index}`, timestamp: Date.now() });
		await f.controller.restore(f.ctx, "turn");
		await f.controller.list(f.ctx, false);
		await f.controller.cache(f.ctx);
	}
	assert.equal(reads.mock.callCount(), initial);
});

test("a later snapshot retains newer native baselines for every released key, not just the edited key", async (t) => {
	const f = await fixture(t);
	await save(f, "read", false);
	await save(f, "read", true);
	system(f.manager, ["write", "other"]);
	f.pi.active.delete("read");
	await f.controller.restore(f.ctx, "tree");
	await save(f, "write", false);
	assert.deepEqual(snapshot(f.manager), state({ write: false }, { read: false, write: true }));
	f.pi.active = new Set(["write", "other"]);
	await f.pi.controller().restore(f.ctx, "start");
	assert.deepEqual([...f.pi.active], ["other"]);
});

test("real Pi /new and /resume initialize fresh native tools even when the target has no system messages", async (t) => {
	const f = await fixture(t);
	// Same public runtime factory used by the CLI: fresh cwd-bound services and
	// AgentSession, not a reused fake host that might conceal native behavior.
	const factory: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd: f.cwd, agentDir: f.agentDir,
			settingsManager: SettingsManager.inMemory({ defaultTools: ["read", "write"] }),
			resourceLoaderOptions: {
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				disabledBuiltinExtensions: ["mcp"],
			},
		});
		return { ...await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent }), services, diagnostics: [] };
	};
	const runtime = await createAgentSessionRuntime(factory, { cwd: f.cwd, agentDir: f.agentDir, sessionManager: f.manager });
	t.after(() => runtime.dispose());
	const host = {
		getAllTools: () => runtime.session.getAllTools(),
		getActiveTools: () => runtime.session.getActiveToolNames(),
		setActiveTools: (names: string[]) => runtime.session.setActiveToolsByName(names),
		appendEntry: (type: string, data: unknown) => { runtime.session.sessionManager.appendCustomEntry(type, data); },
	} as ExtensionAPI;
	const context = (): SessionToolsContext => ({ ...f.ctx, sessionManager: runtime.session.sessionManager });
	const originalSession = runtime.session;
	let controller = new SessionTools(host);
	await controller.save(context(), row(await controller.list(context(), false), "read", false), "session", false);
	assert.equal(runtime.session.getActiveToolNames().includes("read"), false);
	await runtime.newSession();
	assert.notEqual(runtime.session, originalSession);
	assert.equal(runtime.session.getActiveToolNames().includes("read"), true);
	controller = new SessionTools(host);
	await controller.restore(context(), "start");
	assert.equal(row(await controller.list(context(), false)).sessionPreference, undefined);

	const target = SessionManager.create(f.cwd, f.sessions);
	target.appendMessage({ role: "user", content: "no recorded loadout", timestamp: Date.now() });
	await controller.save(context(), row(await controller.list(context(), false), "read", false), "session", false);
	await runtime.switchSession(target.getSessionFile()!);
	assert.equal(runtime.session.getActiveToolNames().includes("read"), true);
	controller = new SessionTools(host);
	await controller.restore(context(), "start");
	assert.equal(row(await controller.list(context(), false)).sessionPreference, undefined);

	await runtime.switchSession(f.manager.getSessionFile()!);
	assert.equal(runtime.session.getActiveToolNames().includes("read"), true, "native defaults precede palette restoration");
	controller = new SessionTools(host);
	await controller.restore(context(), "start");
	assert.equal(runtime.session.getActiveToolNames().includes("read"), false, "the original branch still owns its override");
});

test("cache snapshot cannot absorb a session toggle that happens during cache I/O", async (t) => {
	const f = await fixture(t);
	await save(f, "read", false);
	const realpath = fs.realpath;
	let injected = false;
	t.mock.method(fs, "realpath", async (file: Parameters<typeof fs.realpath>[0]) => {
		if (!injected && String(file) === f.cwd) {
			injected = true;
			await save(f, "write", false);
		}
		return realpath(file);
	});
	await f.controller.list(f.ctx, false);
	assert.equal(injected, true);
	assert.deepEqual([...f.pi.active], ["other"]);
	const cached = JSON.parse(await fs.readFile((await f.cacheFiles())[0], "utf8"));
	assert.equal(cached.tools.find((item: { name: string }) => item.name === "read").enabled, true);
	assert.equal(cached.tools.find((item: { name: string }) => item.name === "write").enabled, true);
	await absent(f.preferences);
});

test("concurrent Session saves append complete snapshots without losing independent choices", async (t) => {
	const f = await fixture(t);
	const items = await f.controller.list(f.ctx, false);
	await Promise.all(["read", "write"].map((name) => f.controller.save(f.ctx, row(items, name, false), "session", false)));
	assert.deepEqual(snapshot(f.manager), state({ read: false, write: false }, { read: true, write: true }));
	assert.deepEqual([...f.pi.active], ["other"]);
});
