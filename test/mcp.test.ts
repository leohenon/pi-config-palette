import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import type { McpItem } from "../items.ts";
import { loadMcpItems, saveMcpToggle } from "../mcp.ts";

function fixture(t: TestContext) {
	const root = fs.mkdtempSync(path.join(tmpdir(), "pi-palette-mcp-"));
	const cwd = path.join(root, "project");
	const agent = path.join(root, "agent");
	const global = path.join(agent, "mcp.json");
	const project = path.join(cwd, ".pi", "mcp.json");
	fs.mkdirSync(agent);
	fs.mkdirSync(path.dirname(project), { recursive: true });
	const old = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	t.after(() => {
		if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = old;
		fs.rmSync(root, { recursive: true, force: true });
	});
	return { ctx: { cwd, isProjectTrusted: () => true }, global, project, root };
}
const write = (file: string, json: unknown) => fs.writeFileSync(file, JSON.stringify(json, null, "\t") + "\n");
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const toggle = (item: McpItem) => ({ ...item, desired: !item.enabled });

test("file-backed MCP inventory shows effective states and never exports transport secrets", async (t) => {
	const { ctx, global, project } = fixture(t);
	assert.deepEqual(await loadMcpItems(ctx), []);
	assert.ok(!fs.existsSync(global) && !fs.existsSync(project));
	write(global, { mcpServers: {
		docs: { url: "https://SECRET.invalid", auth: { provider: "SECRET" }, headers: { key: "!SECRET" }, description: "Docs" },
		local: { command: "SECRET", args: ["SECRET"], env: { SECRET: "${SECRET}" }, enabled: false },
		both: { command: "unused", enabled: false },
	} });
	write(project, { mcpServers: { docs: { toolExposure: { find: "direct" } }, both: { command: "project" } } });
	const rows = await loadMcpItems(ctx, assert.fail);
	assert.deepEqual(rows.map((r) => [r.name, r.scope, r.source, r.enabled, r.isOverride]), [
		["both", "project", project, true, false], ["docs", "project", project, true, true], ["local", "user", global, false, false],
	]);
	assert.equal(rows[1].description, "Docs");
	assert.doesNotMatch(JSON.stringify(rows), /SECRET|\bheaders\b|\bcommand\b|\bprovider\b|toolExposure/);
});

test("toggling existing project overrides writes explicit booleans and never copies global fields", async (t) => {
	const { ctx, global, project } = fixture(t);
	write(global, { mcpServers: { docs: { url: "https://docs.invalid", enabled: false, headers: { token: "SECRET" } } } });
	const original = fs.readFileSync(global);
	const config = { autoEnableCodemode: false, mcpServers: { docs: { exposure: "hidden" }, other: { command: "other" } } };
	write(project, config);
	const [docs] = await loadMcpItems(ctx);
	assert.equal(docs.enabled, false);
	let current = docs;
	for (const enabled of [true, false]) {
		current = await saveMcpToggle(ctx, toggle(current));
		assert.equal(current.enabled, enabled);
		assert.equal((await loadMcpItems(ctx))[0].enabled, enabled);
		assert.deepEqual(read(project), { ...config, mcpServers: { ...config.mcpServers, docs: { exposure: "hidden", enabled } } });
		assert.deepEqual(fs.readFileSync(global), original);
	}
});

test("full definitions save only their enabled setting, retaining sibling and external edits", async (t) => {
	const { ctx, global, project } = fixture(t);
	const full = { command: "local", env: { token: "secret" }, custom: 42 };
	for (const file of [global, project]) {
		write(file, { mcpServers: { docs: full } });
		let [docs] = await loadMcpItems(ctx);
		assert.equal(docs.source, file);
		const sibling = { url: "https://other.invalid" };
		const root = { autoEnableCodemode: false, anotherKey: [3], mcpServers: { docs: full, other: sibling } };
		write(file, root);
		docs = await saveMcpToggle(ctx, toggle(docs));
		assert.deepEqual(read(file), { ...root, mcpServers: { ...root.mcpServers, docs: { ...full, enabled: false } } });
		await saveMcpToggle(ctx, toggle(docs));
		assert.deepEqual(read(file), root);
		if (file === global) assert.equal(fs.existsSync(project), false);
	}
});

test("untrusted projects are neither read nor written, even if trust changes after discovery", async (t) => {
	const { ctx, global, project } = fixture(t);
	write(global, { mcpServers: { docs: { command: "global" } } });
	write(project, { mcpServers: { docs: { enabled: false } } });
	const [before] = await loadMcpItems(ctx);
	const untrusted = { ...ctx, isProjectTrusted: () => false };
	fs.writeFileSync(project, "SECRET not JSON");
	const [globalRow] = await loadMcpItems(untrusted, assert.fail);
	assert.equal(globalRow.scope, "user");
	assert.equal(globalRow.enabled, true);
	await assert.rejects(saveMcpToggle(untrusted, toggle(before)), /not trusted/);
	await saveMcpToggle(untrusted, toggle(globalRow));
	assert.deepEqual(read(global).mcpServers.docs, { command: "global", enabled: false });
	assert.equal(fs.readFileSync(project, "utf8"), "SECRET not JSON");
});

test("a stale row cannot edit another scope, toggle a changed state, or resurrect a removed server", async (t) => {
	const { ctx, global, project } = fixture(t);
	const definition = { command: "global" };
	write(global, { mcpServers: { docs: definition } });
	const [original] = await loadMcpItems(ctx);
	write(project, { mcpServers: { docs: {} } });
	await assert.rejects(saveMcpToggle(ctx, toggle(original)), /changed/);
	assert.deepEqual(read(global).mcpServers.docs, definition);
	assert.deepEqual(read(project).mcpServers.docs, {});
	const [override] = await loadMcpItems(ctx);
	write(project, { mcpServers: { docs: { command: "replacement" } } });
	await assert.rejects(saveMcpToggle(ctx, toggle(override)), /changed/);
	fs.unlinkSync(project);
	await saveMcpToggle(ctx, toggle(original));
	await assert.rejects(saveMcpToggle(ctx, toggle(original)), /changed/);
	write(global, { mcpServers: {} });
	await assert.rejects(saveMcpToggle(ctx, toggle(original)), /changed/);
	assert.deepEqual(read(global), { mcpServers: {} });
});

test("a stale project override cannot enable a different server under the same name", async (t) => {
	const { ctx, global, project } = fixture(t);
	write(global, { mcpServers: { docs: { url: "https://original.invalid" } } });
	write(project, { mcpServers: { docs: { enabled: false } } });
	const [row] = await loadMcpItems(ctx);
	write(global, { mcpServers: { docs: { url: "https://replacement.invalid" } } });
	await assert.rejects(saveMcpToggle(ctx, toggle(row)), /changed/);
	assert.equal(read(project).mcpServers.docs.enabled, false);
	const [fresh] = await loadMcpItems(ctx);
	await saveMcpToggle(ctx, toggle(fresh));
	assert.equal(read(project).mcpServers.docs.enabled, true);
});

test("invalid or conflicting entries are skipped without hiding valid siblings or leaking values", async (t) => {
	const { ctx, global, project } = fixture(t);
	const config = { mcpServers: {
		"a-b": { command: "good" }, a_b: { command: "collision" }, "SECRET;": {},
		docs: { url: "https://example.invalid", oauth: { clientRegistration: "cimd" } },
		bad: { url: "SECRET", enabled: "yes" },
	} };
	write(global, config);
	write(project, { mcpServers: { docs: { env: { token: "SECRET" } }, orphan: { enabled: false },
		forbidden: { url: "https://example.invalid", auth: { provider: "SECRET" } } } });
	const warnings: string[] = [];
	const rows = await loadMcpItems(ctx, (warning) => warnings.push(warning));
	assert.deepEqual(rows.map((row) => [row.name, row.scope]), [["a-b", "user"], ["docs", "user"]]);
	assert.equal(warnings.length, 2);
	assert.doesNotMatch(warnings.join(" "), /SECRET/);
	await saveMcpToggle(ctx, toggle(rows[0]));
	assert.deepEqual(read(global).mcpServers.bad, config.mcpServers.bad);
});

test("a mixed-transport project definition cannot bypass Pi's provider-auth restriction", async (t) => {
	const { ctx, global, project } = fixture(t);
	write(global, { mcpServers: { docs: { command: "global", enabled: false } } });
	const rejected = { type: "stdio", command: "project", url: "https://example.invalid", auth: { provider: "test" } };
	write(project, { mcpServers: { docs: rejected } });
	const [docs] = await loadMcpItems(ctx);
	assert.equal(docs.scope, "user");
	assert.equal(docs.enabled, false);
	await saveMcpToggle(ctx, toggle(docs));
	assert.deepEqual(read(project).mcpServers.docs, rejected);
});

test("malformed JSON and invalid envelopes are reported without exposing or overwriting content", async (t) => {
	const { ctx, global } = fixture(t);
	write(global, { mcpServers: { docs: { command: "docs" } } });
	const [docs] = await loadMcpItems(ctx);
	for (const text of ["{\"mcpServers\": SECRET}", "null", "{\"mcpServers\":[]}"]) {
		fs.writeFileSync(global, text);
		const check = (error: Error) => {
			assert.match(error.message, /Invalid JSON|Expected an object/);
			assert.doesNotMatch(error.message, /SECRET/);
			return true;
		};
		await assert.rejects(loadMcpItems(ctx), check);
		await assert.rejects(saveMcpToggle(ctx, toggle(docs)), check);
		assert.equal(fs.readFileSync(global, "utf8"), text);
	}
});

test("one malformed scope cannot hide valid definitions or be overwritten by toggling the other scope", async (t) => {
	const { ctx, global, project } = fixture(t);
	for (const [broken, healthy] of [[project, global], [global, project]]) {
		fs.writeFileSync(broken, "SECRET invalid JSON");
		write(healthy, { mcpServers: { docs: { command: "docs" } } });
		const warnings: string[] = [];
		const [docs] = await loadMcpItems(ctx, (message) => warnings.push(message));
		assert.equal(docs.source, healthy);
		assert.equal(warnings.length, 1);
		assert.doesNotMatch(warnings[0], /SECRET/);
		await saveMcpToggle(ctx, toggle(docs));
		assert.equal(read(healthy).mcpServers.docs.enabled, false);
		assert.equal(fs.readFileSync(broken, "utf8"), "SECRET invalid JSON");
	}
});

test("an enabled edit preserves unrelated JSON literals verbatim", async (t) => {
	const { ctx, global } = fixture(t);
	const json = '{"extra":12345678901234567890123,"mcpServers":{"docs":{"command":"x","timeout":1e2},"other":{"command":"\\u0078"}}}';
	fs.writeFileSync(global, json);
	const [docs] = await loadMcpItems(ctx);
	const off = await saveMcpToggle(ctx, toggle(docs));
	assert.equal(fs.readFileSync(global, "utf8"), json.replace('"timeout":1e2', '"timeout":1e2,"enabled": false'));
	await saveMcpToggle(ctx, toggle(off));
	assert.equal(fs.readFileSync(global, "utf8"), json);
});

test("ambiguous duplicate server keys cannot report a successful write to a shadowed entry", async (t) => {
	const { ctx, global } = fixture(t);
	const json = '{"mcpServers":{"docs":{"command":"a"},"docs":{"command":"b"}}}';
	fs.writeFileSync(global, json);
	const [docs] = await loadMcpItems(ctx);
	await assert.rejects(saveMcpToggle(ctx, toggle(docs)), /duplicate keys/);
	assert.equal(fs.readFileSync(global, "utf8"), json);
});

test("a project symlink to the global file is a single Global row, never a project-only write", async (t) => {
	const { ctx, global, project } = fixture(t);
	const config = { mcpServers: { docs: { command: "docs" } } };
	write(global, config);
	write(project, config);
	const [projectRow] = await loadMcpItems(ctx);
	fs.unlinkSync(project);
	fs.symlinkSync(global, project);
	await assert.rejects(saveMcpToggle(ctx, toggle(projectRow)), /changed/);
	assert.deepEqual(read(global), config);
	const rows = await loadMcpItems(ctx);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].source, global);
	assert.equal(rows[0].scope, "user");
	await saveMcpToggle(ctx, toggle(rows[0]));
	assert.equal(read(global).mcpServers.docs.enabled, false);
	assert.ok(fs.lstatSync(project).isSymbolicLink());
});

test("editing a hard-linked config is refused before either path changes", async (t) => {
	const { ctx, global, root } = fixture(t);
	const config = { mcpServers: { docs: { command: "docs" } } };
	write(global, config);
	fs.linkSync(global, path.join(root, "shared"));
	const [docs] = await loadMcpItems(ctx);
	await assert.rejects(saveMcpToggle(ctx, toggle(docs)), /hard-linked/);
	assert.deepEqual(read(global), config);
	assert.equal(fs.statSync(global).nlink, 2);
});

test("cooperating saves retain both toggles and preserve a symlinked config and its permissions", async (t) => {
	const { ctx, global, root } = fixture(t);
	const dotfile = path.join(root, "shared.json");
	const config = { mcpServers: { a: { command: "a" }, b: { command: "b" } } };
	const original = "\uFEFF" + JSON.stringify(config, null, "\t").replace(/\n/g, "\r\n") + "\r\n";
	fs.writeFileSync(dotfile, original, { mode: 0o640 });
	const otherGroup = process.getgroups?.().find((gid) => gid !== fs.statSync(dotfile).gid);
	if (otherGroup !== undefined) fs.chownSync(dotfile, fs.statSync(dotfile).uid, otherGroup);
	const before = fs.statSync(dotfile);
	fs.symlinkSync(dotfile, global);
	const rows = await loadMcpItems(ctx);
	const saved = await Promise.all(rows.map((item) => saveMcpToggle(ctx, toggle(item))));
	assert.ok((await loadMcpItems(ctx)).every((item) => !item.enabled));
	await Promise.all(saved.map((item) => saveMcpToggle(ctx, toggle(item))));
	assert.equal(fs.readFileSync(dotfile, "utf8"), original);
	assert.ok(fs.lstatSync(global).isSymbolicLink());
	const after = fs.statSync(dotfile);
	assert.deepEqual([after.dev, after.ino, after.mode, after.uid, after.gid], [before.dev, before.ino, before.mode, before.uid, before.gid]);
});

test("MCP toggles preserve a macOS deny-read ACL on the existing file", { skip: process.platform !== "darwin" }, async (t) => {
	const { ctx, global } = fixture(t);
	const text = '{"mcpServers":{"docs":{"command":"unused","description":"Café"}}}\n';
	fs.writeFileSync(global, text);
	fs.chmodSync(global, 0o644);
	execFileSync("/bin/chmod", ["+a", "user:nobody deny read", global]);
	const acl = () => execFileSync("/bin/ls", ["-led", global], { encoding: "utf8" }).split("\n").slice(1).join("\n");
	const originalAcl = acl();
	assert.match(originalAcl, /nobody deny read/);
	const [docs] = await loadMcpItems(ctx);

	const off = await saveMcpToggle(ctx, toggle(docs));
	assert.equal(read(global).mcpServers.docs.enabled, false);
	assert.equal(acl(), originalAcl);

	await saveMcpToggle(ctx, toggle(off));
	assert.equal(fs.readFileSync(global, "utf8"), text);
	assert.equal(acl(), originalAcl);
});
