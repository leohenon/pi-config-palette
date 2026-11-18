import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import type { ToolInfo, ToolExposure } from "@earendil-works/pi-coding-agent";
import {
	applyToolChange, cacheToolInventory, loadToolItems, restoreToolPreferences,
	type ToolContext, type ToolHost, type ToolItem,
} from "../tools.ts";

async function fixture(t: TestContext) {
	const root = await fs.mkdtemp(path.join(tmpdir(), "pi-palette-tools-"));
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
	const cacheDir = path.join(agentDir, "cache", "pi-config-palette");
	return {
		root, agentDir, cwd, preferences, cacheDir,
		ctx: { cwd, isProjectTrusted: () => true } satisfies ToolContext,
		writePreferences: (value: unknown) => fs.writeFile(preferences, JSON.stringify(value)),
		readPreferences: async () => JSON.parse(await fs.readFile(preferences, "utf8")),
		cacheFiles: async () => (await fs.readdir(cacheDir)).filter((name) => name.endsWith(".json")).map((name) => path.join(cacheDir, name)),
	};
}

function tool(name: string, exposure: ToolExposure = "direct"): ToolInfo {
	return {
		name, description: `Description of ${name}`, parameters: { type: "object" }, exposure,
		sourceInfo: { path: `/extensions/${name}.ts`, source: "local", scope: "user", origin: "top-level" },
	};
}

class Host implements ToolHost {
	calls: string[][] = [];
	onSet?: (names: string[]) => void;
	constructor(public tools = [tool("read"), tool("write"), tool("new_tool")], public active = new Set(["read", "write", "new_tool"])) {}
	getAllTools() { return this.tools; }
	getActiveTools() { return [...this.active]; }
	setActiveTools(names: string[]) {
		this.calls.push([...names]);
		if (this.onSet) return this.onSet(names);
		this.active = new Set(names.filter((name) => this.tools.some((entry) => entry.name === name && entry.exposure !== "hidden")));
	}
}

const unavailableHost: ToolHost = {
	getAllTools() { throw new Error("standalone must not inspect runtime tools"); },
	getActiveTools() { throw new Error("standalone must not inspect active tools"); },
	setActiveTools() { throw new Error("standalone must not mutate runtime tools"); },
};

function choose(items: ToolItem[], name: string, desired?: boolean): ToolItem {
	const item = items.find((entry) => entry.name === name);
	assert.ok(item, `Missing tool ${name}`);
	return { ...item, desired: desired ?? !item.enabled };
}

async function present(file: string): Promise<boolean> {
	try { await fs.access(file); return true; }
	catch { return false; }
}

test("missing and empty preferences never touch the host or import the legacy allowlist", async (t) => {
	const f = await fixture(t);
	await fs.writeFile(path.join(f.agentDir, "tools-config.json"), JSON.stringify({ enabledTools: ["read"] }));
	await restoreToolPreferences(unavailableHost);
	assert.equal(await present(f.preferences), false);
	await f.writePreferences({ version: 1, overrides: {} });
	await restoreToolPreferences(unavailableHost);
	assert.equal(await present(f.cacheDir), false);
});

test("restore merges only explicit available names and retains unknown and hidden preferences", async (t) => {
	const f = await fixture(t);
	const pi = new Host([...new Host().tools, tool("deferred", "deferred"), tool("hidden", "hidden")]);
	const settings = { version: 1, overrides: { write: false, deferred: true, missing: true, hidden: true } };
	await f.writePreferences(settings);
	await restoreToolPreferences(pi);
	assert.deepEqual([...pi.active].sort(), ["deferred", "new_tool", "read"]);
	assert.deepEqual(await f.readPreferences(), settings);
	assert.equal(pi.calls.length, 1);
	await restoreToolPreferences(pi);
	assert.equal(pi.calls.length, 1, "unchanged membership must not trigger another replacement");
	assert.equal(await present(f.cacheDir), false);
	pi.tools.push(tool("missing"));
	await restoreToolPreferences(pi);
	assert.equal(pi.active.has("missing"), true, "unknown preferences survive until registration");
});

test("live inventory shows observed state, not saved preferences, with hidden tools read-only/off", async (t) => {
	const f = await fixture(t);
	const pi = new Host([tool("write"), tool("hidden", "hidden"), tool("read")], new Set(["write", "hidden"]));
	await f.writePreferences({ version: 1, overrides: { read: true, write: false, hidden: true } });
	const items = await loadToolItems(pi, f.ctx, false);
	assert.deepEqual(items.map((item) => item.name), ["hidden", "read", "write"]);
	assert.equal(items[1].enabled, false);
	assert.equal(items[1].desired, false);
	assert.equal(items[1].savedPreference, true);
	assert.equal(items[2].enabled, true);
	assert.equal(items[2].savedPreference, false);
	assert.equal(items[0].enabled, false);
	assert.equal(items[0].mutable, false);
	assert.equal(items[0].inventory, "live");
	assert.equal(items[1].sourcePath, "/extensions/read.ts");
	assert.equal("path" in items[1], false, "tool rows must not impersonate file resources");
	assert.equal(pi.calls.length, 0);
});

test("cache contains only whitelisted metadata, context and timestamp", async (t) => {
	const f = await fixture(t);
	const info = tool("read");
	const parameters: Record<string, unknown> = {};
	parameters.circular = parameters;
	info.parameters = parameters;
	info.reachesTools = () => { throw new Error("must not execute"); };
	const pi = new Host([info], new Set(["read"]));
	await cacheToolInventory(pi, f.ctx);
	const [file] = await f.cacheFiles();
	const cache = JSON.parse(await fs.readFile(file, "utf8"));
	assert.deepEqual(Object.keys(cache).sort(), ["capturedAt", "context", "tools", "version"]);
	assert.deepEqual(cache.context, { cwd: await fs.realpath(f.cwd), projectTrusted: true });
	assert.equal(cache.version, 1);
	assert.equal(new Date(cache.capturedAt).toISOString(), cache.capturedAt);
	assert.deepEqual(cache.tools, [{ name: "read", description: "Description of read", source: "local", sourcePath: "/extensions/read.ts", exposure: "direct", enabled: true }]);
	assert.equal(await present(f.preferences), false);
});

test("shell uses cached observations plus sparse preferences without any host calls or cache writes", async (t) => {
	const f = await fixture(t);
	const pi = new Host([...new Host().tools, tool("hidden", "hidden")]);
	await cacheToolInventory(pi, f.ctx);
	const [cacheFile] = await f.cacheFiles();
	const original = await fs.readFile(cacheFile, "utf8");
	await f.writePreferences({ version: 1, overrides: { read: false, hidden: true, unavailable: true } });
	const items = await loadToolItems(unavailableHost, f.ctx, true);
	assert.equal(choose(items, "read").enabled, false);
	assert.equal(choose(items, "write").enabled, true);
	assert.equal(choose(items, "hidden").enabled, false);
	assert.ok(items.every((item) => item.inventory === "cached"));
	await applyToolChange(unavailableHost, f.ctx, choose(items, "write", false), true);
	assert.deepEqual((await f.readPreferences()).overrides, { read: false, hidden: true, unavailable: true, write: false });
	assert.equal(await fs.readFile(cacheFile, "utf8"), original);
	assert.equal(choose(await loadToolItems(unavailableHost, f.ctx, true), "write").enabled, false);
});

test("cache keys use canonical cwd and project-trust state", async (t) => {
	const f = await fixture(t);
	assert.deepEqual(await loadToolItems(unavailableHost, f.ctx, true), []);
	await cacheToolInventory(new Host(), f.ctx);
	const alias = path.join(f.root, "alias");
	await fs.symlink(f.cwd, alias, "dir");
	assert.equal((await loadToolItems(unavailableHost, { ...f.ctx, cwd: alias }, true)).length, 3);
	const untrusted = { ...f.ctx, isProjectTrusted: () => false };
	assert.deepEqual(await loadToolItems(unavailableHost, untrusted, true), []);
	await cacheToolInventory(new Host([tool("other")], new Set()), untrusted);
	assert.deepEqual((await loadToolItems(unavailableHost, untrusted, true)).map((item) => item.name), ["other"]);
	assert.equal((await f.cacheFiles()).length, 2);
	const other = path.join(f.root, "other-project");
	await fs.mkdir(other);
	assert.deepEqual(await loadToolItems(unavailableHost, { ...f.ctx, cwd: other }, true), []);
});

test("cache failures warn without hiding working live tools", async (t) => {
	const f = await fixture(t);
	await fs.mkdir(path.dirname(f.cacheDir));
	await fs.writeFile(f.cacheDir, "not a directory");
	const warnings: string[] = [];
	const pi = new Host();
	const items = await loadToolItems(pi, f.ctx, false, (warning) => warnings.push(warning));
	assert.equal(items.length, 3);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /Could not cache tool inventory/);
	await assert.rejects(cacheToolInventory(pi, f.ctx));
});

test("malformed preferences are never overwritten or applied", async (t) => {
	const f = await fixture(t);
	const pi = new Host();
	const item = choose(await loadToolItems(pi, f.ctx, false), "write", false);
	const badValues = [null, [], {}, { version: 2, overrides: {} }, { version: 1, overrides: [] },
		{ version: 1, overrides: { write: "false" } }, { version: 1, overrides: { "": true } },
		{ version: 1, overrides: {}, extra: true }];
	for (const value of badValues) {
		await f.writePreferences(value);
		const original = await fs.readFile(f.preferences, "utf8");
		await assert.rejects(restoreToolPreferences(pi), /Invalid tool preferences/);
		await assert.rejects(loadToolItems(pi, f.ctx, false), /Invalid tool preferences/);
		await assert.rejects(applyToolChange(pi, f.ctx, item, false), /Invalid tool preferences/);
		assert.equal(await fs.readFile(f.preferences, "utf8"), original);
	}
	await fs.writeFile(f.preferences, "{broken");
	await assert.rejects(applyToolChange(pi, f.ctx, item, false), /Invalid JSON/);
	assert.equal(await fs.readFile(f.preferences, "utf8"), "{broken");
	assert.equal(pi.calls.length, 0);
	assert.equal(await present(`${f.preferences}.lock`), false);
});

test("malformed cache envelopes and tool entries are rejected", async (t) => {
	const f = await fixture(t);
	await cacheToolInventory(new Host(), f.ctx);
	const [file] = await f.cacheFiles();
	const good = JSON.parse(await fs.readFile(file, "utf8"));
	const badValues = [null, { ...good, version: 2 }, { ...good, capturedAt: "invalid" },
		{ ...good, context: { ...good.context, cwd: "/different-project" } },
		{ ...good, context: { ...good.context, projectTrusted: false } },
		{ ...good, context: { ...good.context, extra: true } },
		{ ...good, tools: {} }, { ...good, tools: [good.tools[0], good.tools[0]] },
		{ ...good, tools: [{ ...good.tools[0], exposure: "unknown" }] },
		{ ...good, tools: [{ ...good.tools[0], enabled: "yes" }] },
		{ ...good, tools: [{ ...good.tools[0], sourcePath: 12 }] },
		{ ...good, tools: [{ ...good.tools[0], parameters: {} }] },
		{ ...good, tools: [{ ...good.tools[0], exposure: "hidden", enabled: true }] }];
	for (const value of badValues) {
		await fs.writeFile(file, JSON.stringify(value));
		await assert.rejects(loadToolItems(unavailableHost, f.ctx, true), /Invalid tool inventory/);
	}
	await fs.writeFile(file, "{broken");
	await assert.rejects(loadToolItems(unavailableHost, f.ctx, true), /Invalid JSON/);
	assert.equal(await fs.readFile(file, "utf8"), "{broken");
});

test("live changes persist only the chosen override and preserve latest unrelated runtime choices", async (t) => {
	const f = await fixture(t);
	const pi = new Host();
	const item = choose(await loadToolItems(pi, f.ctx, false), "write", false);
	await f.writePreferences({ version: 1, overrides: { unknown: false } });
	pi.active.delete("read");
	pi.tools.push(tool("late"));
	pi.active.add("late");
	await applyToolChange(pi, f.ctx, item, false);
	assert.deepEqual([...pi.active].sort(), ["late", "new_tool"]);
	assert.deepEqual(await f.readPreferences(), { version: 1, overrides: { unknown: false, write: false } });
	await applyToolChange(pi, f.ctx, { ...item, desired: true }, false);
	assert.equal(pi.active.has("write"), true);
	assert.equal(pi.active.has("read"), false);
});

test("live change validates current registration and exposure instead of trusting a stale row", async (t) => {
	const f = await fixture(t);
	const pi = new Host();
	const item = choose(await loadToolItems(pi, f.ctx, false), "write", false);
	pi.tools = pi.tools.filter((entry) => entry.name !== "write");
	await assert.rejects(applyToolChange(pi, f.ctx, item, false), /not available.*current runtime/);
	pi.tools.push(tool("write", "hidden"));
	await assert.rejects(applyToolChange(pi, f.ctx, item, false), /hidden/);
	await assert.rejects(applyToolChange(pi, f.ctx, { ...item, mutable: false }, false), /cannot be changed/);
	assert.equal(pi.calls.length, 0);
	assert.equal(await present(f.preferences), false);
});

test("standalone changes must still belong to the current context's non-hidden cached inventory", async (t) => {
	const f = await fixture(t);
	const pi = new Host();
	const item = choose(await loadToolItems(pi, f.ctx, false), "write", false);
	await assert.rejects(applyToolChange(unavailableHost, { ...f.ctx, isProjectTrusted: () => false }, item, true), /not available.*cached inventory/);
	pi.tools = [tool("write", "hidden")];
	await cacheToolInventory(pi, f.ctx);
	await assert.rejects(applyToolChange(unavailableHost, f.ctx, item, true), /hidden/);
	assert.equal(await present(f.preferences), false);
});

test("deferred and codemode tools can be explicitly activated without changing their exposure", async (t) => {
	const f = await fixture(t);
	const pi = new Host([tool("deferred", "deferred"), tool("script", "codemode"), tool("model", "model-only")], new Set());
	for (const name of ["deferred", "script", "model"]) {
		await applyToolChange(pi, f.ctx, choose(await loadToolItems(pi, f.ctx, false), name, true), false);
	}
	assert.equal(pi.active.size, 3);
	await applyToolChange(pi, f.ctx, choose(await loadToolItems(pi, f.ctx, false), "deferred", false), false);
	assert.equal(pi.active.has("deferred"), false);
	assert.equal(pi.getAllTools().find((entry) => entry.name === "deferred")?.exposure, "deferred");
});

test("silent runtime refusal fails clearly and never writes a preference", async (t) => {
	const f = await fixture(t);
	const pi = new Host();
	const item = choose(await loadToolItems(pi, f.ctx, false), "write", false);
	pi.onSet = () => {};
	await assert.rejects(applyToolChange(pi, f.ctx, item, false), /Pi did not deactivate tool "write"/);
	assert.equal(await present(f.preferences), false);
	assert.equal(pi.active.has("write"), true);
	await f.writePreferences({ version: 1, overrides: { write: false } });
	await assert.rejects(restoreToolPreferences(pi), /Pi did not restore/);
});

test("runtime errors after a partial mutation roll back only the chosen membership", async (t) => {
	const f = await fixture(t);
	const pi = new Host();
	const item = choose(await loadToolItems(pi, f.ctx, false), "write", false);
	pi.tools.push(tool("late"));
	let attempts = 0;
	pi.onSet = (names) => {
		pi.active = new Set([...names, "late"]);
		if (attempts++ === 0) throw new Error("runtime failed after mutation");
	};
	await assert.rejects(applyToolChange(pi, f.ctx, item, false), /runtime failed after mutation/);
	assert.equal(pi.active.has("write"), true);
	assert.equal(pi.active.has("late"), true);
	assert.equal(await present(f.preferences), false);
});

test("failed persistence retains the previous file and rolls back only the chosen runtime membership", async (t) => {
	const f = await fixture(t);
	const pi = new Host();
	const item = choose(await loadToolItems(pi, f.ctx, false), "write", false);
	await f.writePreferences({ version: 1, overrides: { prior: true } });
	const original = await fs.readFile(f.preferences, "utf8");
	const rename = fs.rename;
	t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
		if (String(args[1]).endsWith("pi-config-palette-tools.json")) {
			pi.tools.push(tool("late"));
			pi.active.add("late");
			pi.active.delete("read");
			throw new Error("simulated read-only disk");
		}
		return rename(...args);
	});
	await assert.rejects(applyToolChange(pi, f.ctx, item, false), /simulated read-only disk/);
	assert.equal(pi.active.has("write"), true);
	assert.equal(pi.active.has("late"), true);
	assert.equal(pi.active.has("read"), false);
	assert.equal(await fs.readFile(f.preferences, "utf8"), original);
	assert.equal(await present(`${f.preferences}.lock`), false);
	assert.ok((await fs.readdir(f.agentDir)).every((name) => !name.endsWith(".tmp")));
});

test("rollback failure is reported rather than silently claiming consistency", async (t) => {
	const f = await fixture(t);
	const pi = new Host();
	const item = choose(await loadToolItems(pi, f.ctx, false), "write", false);
	t.mock.method(fs, "rename", async () => { throw new Error("disk failed"); });
	let attempts = 0;
	pi.onSet = (names) => {
		if (attempts++ > 0) throw new Error("rollback rejected");
		pi.active = new Set(names);
	};
	await assert.rejects(applyToolChange(pi, f.ctx, item, false), /disk failed.*restore.*rollback rejected/);
	assert.equal(await present(f.preferences), false);
});

test("concurrent preference transactions preserve every session's sparse updates", async (t) => {
	const f = await fixture(t);
	const hosts = Array.from({ length: 16 }, (_, index) => new Host([tool(`tool_${index}`)], new Set()));
	const items = await Promise.all(hosts.map(async (pi) => choose(await loadToolItems(pi, f.ctx, false), pi.tools[0].name, true)));
	await Promise.all(hosts.map((pi, index) => applyToolChange(pi, f.ctx, items[index], false)));
	assert.deepEqual((await f.readPreferences()).overrides, Object.fromEntries(hosts.map((pi) => [pi.tools[0].name, true])));
	assert.ok(hosts.every((pi) => pi.active.has(pi.tools[0].name)));
	assert.equal(await present(`${f.preferences}.lock`), false);
});

test("special object keys are preserved as ordinary tool names without prototype inheritance", async (t) => {
	const f = await fixture(t);
	const pi = new Host([tool("__proto__"), tool("constructor")], new Set());
	const items = await loadToolItems(pi, f.ctx, false);
	assert.ok(items.every((item) => item.savedPreference === undefined));
	await applyToolChange(pi, f.ctx, choose(items, "__proto__", true), false);
	const saved = await f.readPreferences();
	assert.deepEqual(Object.keys(saved.overrides), ["__proto__"]);
	pi.active.clear();
	await restoreToolPreferences(pi);
	assert.deepEqual([...pi.active], ["__proto__"]);
});
