import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { createAgentSession, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type ToolInfo } from "@earendil-works/pi-coding-agent";
import registerPalette from "../index.ts";
import { ConfigPaletteComponent, type PaletteResult } from "../palette.ts";
import { theme } from "./fixtures.ts";
import { applyResourceChanges, loadResources, type ResourceItem } from "../resources.ts";
import { cacheToolInventory, loadToolItems, type ToolHost } from "../tools.ts";

function write(file: string, content: string | object): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
}

function fixture(t: TestContext) {
	const root = fs.mkdtempSync(path.join(tmpdir(), "pi-palette-resources-"));
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".pi", "agent");
	const cwd = path.join(root, "project");
	fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
	const globalFile = path.join(agentDir, "settings.json");
	const projectFile = path.join(cwd, ".pi", "settings.json");
	write(globalFile, {});
	write(projectFile, {});
	const env = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE };
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	t.after(() => {
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(root, { recursive: true, force: true });
	});
	return {
		root, home, agentDir, cwd, globalFile, projectFile,
		ctx: {
			cwd, isProjectTrusted: () => true,
			sessionManager: {
				getSessionFile: () => undefined,
				getSessionId: () => root,
				getBranch: () => [], getEntries: () => [],
			},
		},
		global: () => JSON.parse(fs.readFileSync(globalFile, "utf8")),
		project: () => JSON.parse(fs.readFileSync(projectFile, "utf8")),
	};
}

function byPath(items: ResourceItem[], file: string): ResourceItem {
	const item = items.find((entry) => entry.path === file);
	assert.ok(item, `Missing resource ${file}`);
	return item;
}

function byScope(items: ResourceItem[], file: string, scope: ResourceItem["scope"]): ResourceItem {
	const item = items.find((entry) => entry.path === file && entry.scope === scope);
	assert.ok(item, `Missing ${scope} resource ${file}`);
	return item;
}

function toggle(item: ResourceItem): ResourceItem {
	return { ...item, desired: !item.enabled };
}

function skill(file: string, name: string): void {
	write(file, `---\nname: ${name}\ndescription: Help with ${name}\n---\nInstructions\n`);
}

type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<void>;
function paletteCommand(standalone = false, tools?: ToolHost, events?: Map<string, EventHandler>) {
	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const commands: string[] = [];
	registerPalette({
		registerFlag: (name: string, options: { type: string; default: boolean }) => {
			assert.equal(name, "config-palette-standalone");
			assert.equal(options.type, "boolean");
			assert.equal(options.default, false);
		},
		getFlag: () => standalone,
		getAllTools: () => tools?.getAllTools() ?? [],
		getActiveTools: () => tools?.getActiveTools() ?? [],
		setActiveTools: (names: string[]) => { tools?.setActiveTools(names); },
		appendEntry: (type: string, data: unknown) => {
			const append = (tools as ToolHost & Partial<Pick<ExtensionAPI, "appendEntry">>)?.appendEntry;
			assert.ok(append, "unexpected session write");
			append(type, data);
		},
		on: (name: string, handler: EventHandler) => { events?.set(name, handler); return () => {}; },
		registerCommand: (name: string, command: { handler: typeof handler }) => {
			commands.push(name);
			if (name === "config-palette") handler = command.handler;
		},
	} as unknown as ExtensionAPI);
	assert.deepEqual(commands, ["config-palette"]);
	assert.ok(handler);
	return handler;
}

function toolHost() {
	const definitions: ToolInfo[] = ["read", "write"].map((name) => ({
		name, description: `${name} tool`, parameters: { type: "object" }, exposure: "direct",
		sourceInfo: { path: `builtin:${name}`, source: "builtin", scope: "user", origin: "top-level" },
	}));
	let active = ["read", "write"];
	return {
		getAllTools: () => definitions,
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => { active = [...names]; },
	};
}

type Factory = Parameters<ExtensionCommandContext["ui"]["custom"]>[0];
async function openPicker(factory: Factory, requestRender = () => {}) {
	let finish!: (result: unknown) => void;
	const closed = new Promise((resolve) => { finish = resolve; });
	const tui = { requestRender, terminal: { rows: 24 } } as Parameters<Factory>[0];
	const component = await factory(tui, theme, {} as Parameters<Factory>[2], finish);
	return { component, closed };
}
async function usePicker(factory: Factory, keys: string[], inspect?: (lines: string[]) => void): Promise<unknown> {
	const { component, closed } = await openPicker(factory);
	inspect?.(component.render(96));
	for (const key of keys) component.handleInput!(key);
	return closed;
}

test("package metadata names generic entrypoints and distinguishes multiple extensions", async (t) => {
	const f = fixture(t);
	const pkg = path.join(f.root, "checkout");
	const main = path.join(pkg, "src/index.ts");
	const supervisor = path.join(pkg, "dist/supervisor.js");
	write(path.join(pkg, "package.json"), {
		name: "pi-tmux", description: "Manage tmux panes", pi: { extensions: ["src/index.ts", "dist/supervisor.js"] },
	});
	write(main, "throw new Error('must not execute during discovery')");
	write(supervisor, "export default () => {};");
	write(f.globalFile, { packages: [{ source: pkg, extensions: [] }] });
	const items = await loadResources(f.ctx);
	assert.equal(byPath(items, main).name, "pi-tmux");
	assert.equal(byPath(items, supervisor).name, "pi-tmux / supervisor");
	assert.equal(byPath(items, main).description, "Manage tmux panes");
	assert.equal(byPath(items, main).packageName, "pi-tmux");
	assert.equal(byPath(items, main).enabled, false);
	assert.equal(byPath(items, main).mutable, true);
});

test("single package src/index uses its identity; local auto directory index uses the directory", async (t) => {
	const f = fixture(t);
	const pkg = path.join(f.root, "package-checkout");
	const main = path.join(pkg, "src/index.ts");
	write(path.join(pkg, "package.json"), { name: "@example/pi-tools", pi: { extensions: ["src/index.ts"] } });
	write(main, "");
	const local = path.join(f.agentDir, "extensions/local-helper/index.ts");
	const single = path.join(f.agentDir, "extensions/check-status.ts");
	write(local, "");
	write(single, "");
	write(f.globalFile, { packages: [pkg] });
	const items = await loadResources(f.ctx);
	assert.equal(byPath(items, main).name, "@example/pi-tools");
	assert.equal(byPath(items, local).name, "local-helper");
	assert.equal(byPath(items, single).name, "check-status");
});

test("live and shell Tools rows use the real package extension's display name", async (t) => {
	const f = fixture(t);
	const pkg = path.join(f.root, "checkout");
	write(path.join(pkg, "package.json"), { name: "@test/reports", pi: { extensions: ["src/index.ts"] } });
	write(path.join(pkg, "src/index.ts"), `export default pi => pi.registerTool({
		name: "preview_report", label: "Preview", description: "Preview a report", parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [] })
	});`);
	write(f.globalFile, { packages: [pkg] });
	const { session } = await createAgentSession({ cwd: f.cwd, agentDir: f.agentDir, sessionManager: SessionManager.inMemory(f.cwd) });
	t.after(() => session.dispose());
	await session.bindExtensions({});
	const host: ToolHost = {
		getAllTools: () => session.getAllTools(), getActiveTools: () => session.getActiveToolNames(),
		setActiveTools: () => assert.fail("displaying the extension must not change tool state"),
	};
	for (const standalone of [false, true]) {
		const ctx = {
			...f.ctx, mode: "tui", shutdown() {},
			ui: {
				setFooter() {}, notify: (message: string) => assert.fail(message),
				custom: async (factory: Factory) => {
					const { component, closed } = await openPicker(factory);
					for (const key of ["3", "/", ..."@test/reports", "\r"]) component.handleInput!(key);
					assert.match(stripVTControlCharacters(component.render(96).join("\n")), /preview_report +\[@test\/reports\]/);
					component.handleInput!("\x1b");
					component.handleInput!("\x1b");
					return closed;
				},
			},
		} as unknown as ExtensionCommandContext;
		await paletteCommand(standalone, standalone ? undefined : host)("", ctx);
	}
});

test("colliding generic package entrypoints get distinct labels", async (t) => {
	const f = fixture(t);
	const pkg = path.join(f.root, "generic-package");
	write(path.join(pkg, "package.json"), { name: "generic-package", pi: { extensions: ["src/index.ts", "dist/index.js"] } });
	write(path.join(pkg, "src/index.ts"), "");
	write(path.join(pkg, "dist/index.js"), "");
	write(f.globalFile, { packages: [pkg] });
	const items = await loadResources(f.ctx);
	assert.deepEqual(new Set(items.map((item) => item.name)), new Set(["generic-package / src/index.ts", "generic-package / dist/index.js"]));
});

test("skills use Pi's YAML parser, with meaningful fallbacks for malformed and standalone files", async (t) => {
	const f = fixture(t);
	const valid = path.join(f.agentDir, "skills/folder-name/SKILL.md");
	const malformed = path.join(f.agentDir, "skills/broken/SKILL.md");
	const standalone = path.join(f.agentDir, "skills/standalone.md");
	write(valid, '\uFEFF---\r\nname: "actual-name"\r\ndescription: >-\r\n  First line\r\n  second line\r\n---\r\n');
	write(malformed, "---\nname: [unterminated\n---\n");
	write(standalone, "No frontmatter");
	const items = await loadResources(f.ctx);
	assert.equal(byPath(items, valid).name, "actual-name");
	assert.equal(byPath(items, valid).description, "First line second line");
	assert.equal(byPath(items, malformed).name, "broken");
	assert.equal(byPath(items, standalone).name, "standalone");
});

test("empty package filters enable only the chosen entry, preserving other types and settings", async (t) => {
	const f = fixture(t);
	const pkg = path.join(f.root, "package");
	const chosen = path.join(pkg, "skills/chosen/SKILL.md");
	const other = path.join(pkg, "skills/other/SKILL.md");
	const hidden = path.join(pkg, ".hidden.md");
	skill(chosen, "chosen");
	skill(other, "other");
	skill(hidden, "hidden");
	write(path.join(pkg, "package.json"), { name: "test-package", pi: { skills: ["skills", ".hidden.md"] } });
	write(f.globalFile, { theme: "dark", packages: [{ source: pkg, skills: [], extensions: [], prompts: ["keep.md"] }] });
	const before = await loadResources(f.ctx);
	assert.ok(before.every((item) => !item.enabled));
	assert.equal(byPath(before, chosen).name, "chosen");
	assert.equal(byPath(before, chosen).packageName, "test-package");
	await applyResourceChanges(f.ctx, [toggle(byPath(before, chosen))]);
	const after = await loadResources(f.ctx);
	assert.equal(byPath(after, chosen).enabled, true);
	assert.equal(byPath(after, other).enabled, false);
	assert.equal(byPath(after, hidden).enabled, false);
	assert.equal(f.global().theme, "dark");
	assert.deepEqual(f.global().packages[0].extensions, []);
	assert.deepEqual(f.global().packages[0].prompts, ["keep.md"]);
});

test("autoload:false project packages remain deltas over the user package", async (t) => {
	const f = fixture(t);
	const pkg = path.join(f.root, "package");
	const chosen = path.join(pkg, "skills/chosen/SKILL.md");
	const other = path.join(pkg, "skills/other/SKILL.md");
	skill(chosen, "chosen");
	skill(other, "other");
	write(f.globalFile, { packages: [pkg] });
	write(f.projectFile, { packages: [{ source: pkg, autoload: false, skills: ["-skills/chosen"], extensions: [] }] });
	const before = await loadResources(f.ctx);
	assert.equal(byPath(before, chosen).scope, "project");
	assert.equal(byPath(before, chosen).enabled, false);
	await applyResourceChanges(f.ctx, [toggle(byPath(before, chosen))]);
	const after = await loadResources(f.ctx);
	assert.equal(byPath(after, chosen).enabled, true);
	assert.equal(byPath(after, other).enabled, true);
	assert.equal(byPath(after, other).scope, "user");
	assert.deepEqual(f.project().packages[0], { source: pkg, autoload: false, skills: ["+skills/chosen/SKILL.md"], extensions: [] });
	assert.deepEqual(f.global().packages, [pkg]);
});

test("global skill rows survive project overrides and global edits never remove the project rule", async (t) => {
	const f = fixture(t);
	const pkg = path.join(f.root, "package");
	const chosen = path.join(pkg, "skills/chosen/SKILL.md");
	skill(chosen, "chosen");
	write(f.globalFile, { packages: [pkg] });
	write(f.projectFile, { packages: [{ source: "../../package", autoload: false, skills: ["-skills/chosen"] }] });
	const projectBefore = fs.readFileSync(f.projectFile, "utf8");
	let items = await loadResources(f.ctx);
	const global = byScope(items, chosen, "user");
	const project = byScope(items, chosen, "project");
	assert.equal(global.enabled, true);
	assert.equal(global.projectEnabled, false);
	assert.equal(global.projectOverrideId, project.id);
	assert.equal(project.enabled, false);
	await applyResourceChanges(f.ctx, [toggle(global)]);
	items = await loadResources(f.ctx);
	assert.equal(byScope(items, chosen, "user").enabled, false);
	assert.equal(byScope(items, chosen, "project").enabled, false);
	assert.equal(fs.readFileSync(f.projectFile, "utf8"), projectBefore);
	await applyResourceChanges(f.ctx, [toggle(byScope(items, chosen, "user"))]);
	items = await loadResources(f.ctx);
	assert.equal(byScope(items, chosen, "user").enabled, true);
	assert.equal(byScope(items, chosen, "user").projectEnabled, false);
	assert.equal(fs.readFileSync(f.projectFile, "utf8"), projectBefore);
});

test("equal explicit project overrides remain tracked when the global value changes", async (t) => {
	const f = fixture(t);
	const pkg = path.join(f.root, "package");
	const file = path.join(pkg, "skills/example/SKILL.md");
	skill(file, "example");
	write(f.globalFile, { packages: [pkg] });
	write(f.projectFile, { packages: [{ source: pkg, autoload: false, skills: ["+skills/example"] }] });
	let items = await loadResources(f.ctx);
	assert.equal(byScope(items, file, "user").projectEnabled, true);
	await applyResourceChanges(f.ctx, [toggle(byScope(items, file, "user"))]);
	items = await loadResources(f.ctx);
	assert.equal(byScope(items, file, "user").enabled, false);
	assert.equal(byScope(items, file, "user").projectEnabled, true);
	const globalBefore = fs.readFileSync(f.globalFile, "utf8");
	await applyResourceChanges(f.ctx, [toggle(byScope(items, file, "project"))]);
	items = await loadResources(f.ctx);
	assert.equal(byScope(items, file, "user").enabled, false);
	assert.equal(byScope(items, file, "user").projectEnabled, false);
	assert.equal(fs.readFileSync(f.globalFile, "utf8"), globalBefore);
});

test("project exclusion patterns alone do not invent overrides for global skills", async (t) => {
	const f = fixture(t);
	const file = path.join(f.agentDir, "skills/example/SKILL.md");
	skill(file, "example");
	write(f.projectFile, { skills: ["!**", `-${file}`] });
	const items = await loadResources(f.ctx);
	assert.equal(byScope(items, file, "user").enabled, true);
	assert.equal(byScope(items, file, "user").projectEnabled, undefined);
	assert.equal(items.some((item) => item.scope === "project"), false);
});

test("explicit project selection of a global top-level file is an independently editable override", async (t) => {
	const f = fixture(t);
	const file = path.join(f.agentDir, "skills/example/SKILL.md");
	skill(file, "example");
	write(f.projectFile, { skills: [file, `-${file}`] });
	let items = await loadResources(f.ctx);
	assert.equal(byScope(items, file, "user").projectEnabled, false);
	await applyResourceChanges(f.ctx, [toggle(byScope(items, file, "user"))]);
	items = await loadResources(f.ctx);
	await applyResourceChanges(f.ctx, [toggle(byScope(items, file, "project"))]);
	items = await loadResources(f.ctx);
	assert.equal(byScope(items, file, "user").enabled, false);
	assert.equal(byScope(items, file, "user").projectEnabled, true);
});

test("skill override identity uses real paths, not names", async (t) => {
	const f = fixture(t);
	const globalFile = path.join(f.agentDir, "skills/shared/SKILL.md");
	const projectFile = path.join(f.cwd, ".pi/skills/shared/SKILL.md");
	skill(globalFile, "shared-name");
	skill(projectFile, "shared-name");
	write(f.projectFile, { skills: ["-skills/shared/SKILL.md"] });
	let items = await loadResources(f.ctx);
	assert.equal(byScope(items, globalFile, "user").projectEnabled, undefined);
	fs.unlinkSync(projectFile);
	fs.symlinkSync(globalFile, projectFile);
	items = await loadResources(f.ctx);
	assert.equal(byScope(items, globalFile, "user").projectEnabled, false);
	assert.equal(byScope(items, globalFile, "user").projectOverrideId, byScope(items, projectFile, "project").id);
	const untrusted = await loadResources({ ...f.ctx, isProjectTrusted: () => false });
	assert.equal(byScope(untrusted, globalFile, "user").projectEnabled, undefined);
	assert.equal(untrusted.some((item) => item.scope === "project"), false);
});

test("a replaced package's absent effective file is retained globally without a false disabled note", async (t) => {
	const f = fixture(t);
	const pkg = path.join(f.agentDir, "npm/node_modules/test-palette-skills");
	const file = path.join(pkg, "skills/example/SKILL.md");
	write(path.join(pkg, "package.json"), { name: "test-palette-skills", version: "1.0.0", pi: { skills: ["skills"] } });
	skill(file, "example");
	write(f.globalFile, { packages: ["npm:test-palette-skills@1.0.0"] });
	write(f.projectFile, { packages: ["npm:test-palette-skills@2.0.0"] });
	const projectBefore = fs.readFileSync(f.projectFile, "utf8");
	const item = byScope(await loadResources(f.ctx), file, "user");
	assert.equal(item.projectEnabled, undefined);
	await applyResourceChanges(f.ctx, [toggle(item)]);
	assert.equal(byScope(await loadResources(f.ctx), file, "user").enabled, false);
	assert.equal(fs.readFileSync(f.projectFile, "utf8"), projectBefore);
});

test("absolute top-level tokens replace exact aliases without deleting discovery paths or globs", async (t) => {
	const f = fixture(t);
	const chosen = path.join(f.cwd, ".pi/custom/chosen/SKILL.md");
	skill(chosen, "chosen");
	const parent = path.dirname(chosen);
	write(f.projectFile, { skills: ["custom", "!**", "-./custom/chosen", `-${chosen}`, `+${parent}`], theme: "light" });
	const before = await loadResources(f.ctx);
	const item = byPath(before, chosen);
	assert.equal(item.baseDir, path.join(f.cwd, ".pi"));
	assert.equal(item.enabled, false);
	await applyResourceChanges(f.ctx, [toggle(item)]);
	assert.deepEqual(f.project().skills, ["custom", "!**", `+${chosen}`]);
	assert.equal(f.project().theme, "light");
	assert.equal(byPath(await loadResources(f.ctx), chosen).enabled, true);
});

test("tilde exact aliases are removed and written as precise absolute paths", async (t) => {
	const f = fixture(t);
	const chosen = path.join(f.agentDir, "skills/chosen/SKILL.md");
	skill(chosen, "chosen");
	write(f.globalFile, { skills: ["-~/.pi/agent/skills/chosen", "-./skills/chosen/SKILL.md"] });
	const before = await loadResources(f.ctx);
	await applyResourceChanges(f.ctx, [toggle(byPath(before, chosen))]);
	assert.deepEqual(f.global().skills, [`+${chosen}`]);
	assert.equal(byPath(await loadResources(f.ctx), chosen).enabled, true);
});

test("replacing ambiguous .pi/.agents aliases preserves the other skill and unique IDs", async (t) => {
	const f = fixture(t);
	const piSkill = path.join(f.agentDir, "skills/shared/SKILL.md");
	const agentsSkill = path.join(f.home, ".agents/skills/shared/SKILL.md");
	skill(piSkill, "pi-shared");
	skill(agentsSkill, "agents-shared");
	write(f.globalFile, { skills: ["-skills/shared"] });
	const before = await loadResources(f.ctx);
	assert.notEqual(byPath(before, piSkill).id, byPath(before, agentsSkill).id);
	assert.equal(byPath(before, piSkill).enabled, false);
	assert.equal(byPath(before, agentsSkill).enabled, false);
	await applyResourceChanges(f.ctx, [toggle(byPath(before, piSkill))]);
	const after = await loadResources(f.ctx);
	assert.equal(byPath(after, piSkill).enabled, true);
	assert.equal(byPath(after, agentsSkill).enabled, false);
	assert.deepEqual(new Set(f.global().skills), new Set([`+${piSkill}`, `-${agentsSkill}`]));
});

test("declined trust skips project discovery; revoked trust aborts all writes", async (t) => {
	const f = fixture(t);
	const userFile = path.join(f.agentDir, "extensions/user.ts");
	const projectFile = path.join(f.cwd, ".pi/extensions/project.ts");
	write(userFile, "");
	write(projectFile, "");
	const trusted = await loadResources(f.ctx);
	const untrusted = { ...f.ctx, isProjectTrusted: () => false };
	write(f.projectFile, "malformed untrusted settings");
	assert.deepEqual((await loadResources(untrusted)).map((item) => item.path), [userFile]);
	await assert.rejects(applyResourceChanges(untrusted, trusted.map(toggle)), /Project is not trusted/);
	assert.deepEqual(f.global(), {});
	assert.equal(fs.readFileSync(f.projectFile, "utf8"), "malformed untrusted settings");
});

test("removed packages abort the entire save rather than recreating the declaration", async (t) => {
	const f = fixture(t);
	const pkg = path.join(f.root, "package");
	const chosen = path.join(pkg, "extensions/chosen.ts");
	write(chosen, "");
	write(path.join(f.agentDir, "extensions/local.ts"), "");
	write(f.globalFile, { packages: [pkg] });
	const before = await loadResources(f.ctx);
	write(f.globalFile, { packages: [], theme: "dark" });
	await assert.rejects(applyResourceChanges(f.ctx, before.map(toggle)), /Package disappeared/);
	assert.deepEqual(f.global(), { packages: [], theme: "dark" });
});

test("local file packages and bare directory fallback packages are read-only", async (t) => {
	const f = fixture(t);
	const single = path.join(f.root, "single.ts");
	const bare = path.join(f.root, "bare-directory");
	write(single, "");
	write(path.join(bare, "index.ts"), "");
	write(f.globalFile, { packages: [single, bare] });
	const before = await loadResources(f.ctx);
	assert.equal(byPath(before, single).name, "single");
	assert.equal(byPath(before, single).mutable, false);
	assert.equal(byPath(before, bare).mutable, false);
	await applyResourceChanges(f.ctx, before.map(toggle));
	assert.deepEqual(f.global(), { packages: [single, bare] });
});

test("ordinary string packages can disable one extension without changing siblings", async (t) => {
	const f = fixture(t);
	const pkg = path.join(f.root, "package");
	const chosen = path.join(pkg, "extensions/chosen.ts");
	const other = path.join(pkg, "extensions/other.ts");
	write(chosen, "");
	write(other, "");
	write(f.globalFile, { packages: [pkg] });
	const before = await loadResources(f.ctx);
	await applyResourceChanges(f.ctx, [toggle(byPath(before, chosen))]);
	const after = await loadResources(f.ctx);
	assert.equal(byPath(after, chosen).enabled, false);
	assert.equal(byPath(after, other).enabled, true);
	assert.deepEqual(f.global().packages, [{ source: pkg, extensions: ["-extensions/chosen.ts"] }]);
});

test("manifest packages whose filters could expose undeclared convention directories are read-only", async (t) => {
	const f = fixture(t);
	const pkg = path.join(f.root, "package");
	const main = path.join(pkg, "src/index.ts");
	write(path.join(pkg, "package.json"), { name: "explicit-package", pi: { extensions: ["src/index.ts"] } });
	write(main, "");
	skill(path.join(pkg, "skills/undeclared/SKILL.md"), "undeclared");
	write(f.globalFile, { packages: [pkg] });
	const before = await loadResources(f.ctx);
	assert.equal(before.length, 1);
	assert.equal(byPath(before, main).mutable, false);
	await applyResourceChanges(f.ctx, before.map(toggle));
	assert.deepEqual(f.global().packages, [pkg]);
	assert.equal((await loadResources(f.ctx)).length, 1);
});

test("settings parse errors are surfaced and never overwritten", async (t) => {
	const f = fixture(t);
	write(path.join(f.agentDir, "extensions/local.ts"), "");
	const before = await loadResources(f.ctx);
	write(f.globalFile, "{bad json");
	await assert.rejects(loadResources(f.ctx), /Failed to read Pi settings/);
	await assert.rejects(applyResourceChanges(f.ctx, before.map(toggle)), /Failed to read Pi settings/);
	assert.equal(fs.readFileSync(f.globalFile, "utf8"), "{bad json");
});

test("queued settings write errors are surfaced after flush", async (t) => {
	const f = fixture(t);
	write(path.join(f.agentDir, "extensions/local.ts"), "");
	const before = await loadResources(f.ctx);
	const setPaths = SettingsManager.prototype.setExtensionPaths;
	t.mock.method(SettingsManager.prototype, "setExtensionPaths", function (this: SettingsManager, paths: string[]) {
		setPaths.call(this, paths);
		// The setter queues its write; replace only our isolated settings file before it runs.
		fs.rmSync(f.globalFile);
		fs.mkdirSync(f.globalFile);
	});
	await assert.rejects(applyResourceChanges(f.ctx, before.map(toggle)), /Failed to save Pi settings/);
});

test("skill and extension toggles write real settings before the palette closes", async (t) => {
	const f = fixture(t);
	const skillPath = path.join(f.agentDir, "skills/example/SKILL.md");
	const extensionPath = path.join(f.agentDir, "extensions/example.ts");
	skill(skillPath, "example");
	write(extensionPath, "");
	const results: PaletteResult[] = [];
	const errors: string[] = [];
	let saving = Promise.resolve();
	const ui = new ConfigPaletteComponent(await loadResources(f.ctx), theme, {
		requestRender() {}, rows: () => 24,
		saveToggle: (item) => {
			if (item.kind !== "skill" && item.kind !== "extension") assert.fail("expected a resource");
			saving = applyResourceChanges(f.ctx, [item]);
			return saving;
		},
		saveFavorite: async () => assert.fail("unexpected favorite save"),
		notifyError: (message) => { errors.push(message); },
	}, (result) => results.push(result));
	for (const expected of [false, true, false]) {
		ui.handleInput(" ");
		await saving;
		assert.equal(byPath(await loadResources(f.ctx), skillPath).enabled, expected);
		assert.equal(results.length, 0);
	}
	ui.handleInput("l");
	ui.handleInput("\r");
	await saving;
	assert.equal(byPath(await loadResources(f.ctx), extensionPath).enabled, false);
	assert.equal(results.length, 0);
	ui.handleInput("\x1b");
	assert.equal(results[0].savedChanges, true);
	assert.deepEqual(errors, []);
});

test("inline command reloads after Escape waits for an in-flight immediate save", { timeout: 5000 }, async (t) => {
	const f = fixture(t);
	const file = path.join(f.agentDir, "skills/example/SKILL.md");
	skill(file, "example");
	const handler = paletteCommand();
	let reloads = 0;
	let overlayClosed = false;
	const errors: string[] = [];
	const ctx = {
		...f.ctx, mode: "tui",
		waitForIdle: async () => {},
		reload: async () => {
			assert.equal(overlayClosed, true);
			assert.equal(byPath(await loadResources(f.ctx), file).enabled, false);
			reloads++;
		},
		ui: {
			notify: (message: string) => { errors.push(message); },
			setFooter: () => assert.fail("embedded picker must keep Pi's footer"),
			custom: async (factory: Factory, options: Parameters<ExtensionCommandContext["ui"]["custom"]>[1]) => {
				assert.equal(options?.overlay, false);
				assert.equal(options?.overlayOptions, undefined);
				const result = await usePicker(factory, [" ", "\x1b"], (lines) => {
					assert.match(stripVTControlCharacters(lines.join("\n")), /\/ Search[\s\S]*Help with example/);
				});
				overlayClosed = true;
				return result;
			},
		},
	} as unknown as ExtensionCommandContext;
	assert.ok(handler);
	await handler("", ctx);
	assert.equal(reloads, 1);
	assert.deepEqual(errors, []);
});

test("favorites persist between embedded and standalone palettes without a reload", { timeout: 5000 }, async (t) => {
	const f = fixture(t);
	const file = path.join(f.agentDir, "mcp.json");
	const server = { command: "docs" };
	write(file, { mcpServers: { docs: server } });

	const run = (standalone: boolean, expectedStar: boolean, keys: string[]) => paletteCommand(standalone)("", {
		...f.ctx, mode: "tui",
		waitForIdle: () => assert.fail("starring must not wait for reload"),
		reload: () => assert.fail("starring must not reload"),
		shutdown() {},
		ui: {
			notify: (message: string) => assert.fail(message),
			setFooter() {},
			custom: async (factory: Factory) => {
				const { component, closed } = await openPicker(factory);
				component.handleInput!("4");
				const screen = stripVTControlCharacters(component.render(96).join("\n"));
				assert.match(screen, expectedStar ? /\[ ON\] ★ docs/ : /\[ ON\] docs/);
				for (const key of keys) component.handleInput!(key);
				return closed;
			},
		},
	} as unknown as ExtensionCommandContext);

	await run(false, false, ["f", "\x1b"]);
	assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.docs, server);
	// An MCP definition edit changes the row ID but must not lose its star.
	write(file, { mcpServers: { docs: { ...server, description: "Updated" } } });
	await run(true, true, ["f", "\x1b"]);
	await run(false, false, ["\x1b"]);
});

test("multiple MCP edits autosave, then reload once in Pi or just exit in the shell", { timeout: 5000 }, async (t) => {
	for (const standalone of [false, true]) {
		await t.test(standalone ? "standalone" : "embedded", async (t) => {
			const f = fixture(t);
			const file = path.join(f.agentDir, "mcp.json");
			write(file, { mcpServers: { a: { command: "a" }, b: { command: "b" } } });
			const calls: string[] = [];
			const ctx = {
				...f.ctx, mode: "tui",
				waitForIdle: () => { calls.push("idle"); }, reload: () => { calls.push("reload"); }, shutdown: () => { calls.push("exit"); },
				ui: {
					setFooter() {}, notify: (message: string) => assert.fail(message),
					custom: async (factory: Factory) => {
						let rendered = () => {};
						const { component, closed } = await openPicker(factory, () => rendered());
						component.handleInput!("4");
						component.handleInput!(" ");
						await new Promise<void>((resolve) => { rendered = resolve; });
						assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.a.enabled, false);
						assert.deepEqual(calls, []);
						component.handleInput!("k");
						component.handleInput!("\r");
						component.handleInput!("\x03");
						return closed;
					},
				},
			} as unknown as ExtensionCommandContext;
			await paletteCommand(standalone)("", ctx);
			assert.deepEqual(calls, standalone ? ["exit"] : ["idle", "reload"]);
			assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.b.enabled, false);
		});
	}
});

test("an MCP flush failure keeps the toggle and reloads only if the saved bytes match", { timeout: 5000 }, async (t) => {
	for (const matches of [true, false]) {
		await t.test(matches ? "matches the write" : "file changed during the flush", async (t) => {
			const f = fixture(t);
			const file = path.join(f.agentDir, "mcp.json");
			write(file, { mcpServers: { docs: { command: "docs" } } });
			const { dev, ino } = fs.statSync(file, { bigint: true });
			const fsync = fs.fsyncSync;
			const patched = t.mock.method(fs, "fsyncSync", (fd: number) => {
				const stat = fs.fstatSync(fd, { bigint: true });
				if (stat.dev !== dev || stat.ino !== ino) return fsync(fd);
				if (!matches) fs.appendFileSync(file, "\n");
				throw new Error("simulated flush failure");
			});
			syncBuiltinESMExports();
			t.after(() => { patched.mock.restore(); syncBuiltinESMExports(); });

			let reloads = 0;
			const notifications: Array<{ message: string; level?: string }> = [];
			const ctx = {
				...f.ctx, mode: "tui", waitForIdle() {}, reload: () => { reloads++; },
				ui: {
					notify: (message: string, level?: string) => { notifications.push({ message, level }); },
					custom: async (factory: Factory) => {
						let rendered = () => {};
						const { component, closed } = await openPicker(factory, () => rendered());
						component.handleInput!("4");
						component.handleInput!(" ");
						await new Promise<void>((resolve) => { rendered = resolve; });
						const lines = stripVTControlCharacters(component.render(96).join("\n"));
						assert.match(lines, matches ? /\[OFF\] docs/ : /\[ ON\] docs/);
						if (matches) assert.doesNotMatch(lines, /Save failed/);
						else assert.match(lines, /Save failed/);
						component.handleInput!("\x1b");
						return closed;
					},
				},
			} as unknown as ExtensionCommandContext;
			await paletteCommand()("", ctx);
			assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.docs.enabled, false);
			assert.equal(reloads, matches ? 1 : 0);
			assert.deepEqual(notifications.map(({ level }) => level), [matches ? "warning" : "error"]);
			assert.match(notifications[0].message, matches ? /may not survive a crash/ : /simulated flush failure.*Check the file/);
		});
	}
});

test("MCP errors neither reload nor block the other tabs", { timeout: 5000 }, async (t) => {
	const f = fixture(t);
	const file = path.join(f.agentDir, "mcp.json");
	write(file, { mcpServers: { docs: { command: "docs" } } });
	skill(path.join(f.agentDir, "skills/working/SKILL.md"), "working");
	const errors: string[] = [];
	for (const alreadyInvalid of [false, true]) {
		const ctx = {
			...f.ctx, mode: "tui", waitForIdle: () => assert.fail("no successful edits"), reload: () => assert.fail("no successful edits"),
			ui: {
				notify: (message: string) => { errors.push(message); },
				custom: async (factory: Factory) => {
					let rendered = () => {};
					const { component, closed } = await openPicker(factory, () => rendered());
					assert.match(component.render(96).join("\n"), /working/);
					component.handleInput!("4");
					if (alreadyInvalid) {
						assert.match(component.render(96).join("\n"), /MCP configuration unavailable/);
					} else {
						write(file, "SECRET broken JSON");
						component.handleInput!(" ");
						await new Promise<void>((resolve) => { rendered = resolve; });
						assert.match(component.render(96).join("\n"), /Save failed/);
					}
					component.handleInput!("\x1b");
					return closed;
				},
			},
		} as unknown as ExtensionCommandContext;
		await paletteCommand()("", ctx);
	}
	assert.equal(errors.length, 2);
	assert.doesNotMatch(errors.join(" "), /SECRET/);
	assert.equal(fs.readFileSync(file, "utf8"), "SECRET broken JSON");
});

test("tool-only edits apply live and persist without reloading Pi", { timeout: 5000 }, async (t) => {
	const f = fixture(t);
	const host = toolHost();
	const errors: string[] = [];
	const ctx = {
		...f.ctx, mode: "tui",
		reload: () => assert.fail("tool changes must not reload Pi"),
		waitForIdle: () => assert.fail("tool changes apply without a resource reload"),
		ui: {
			notify: (message: string) => { errors.push(message); },
			custom: (factory: Factory) => usePicker(factory, ["3", " ", "\x1b"], (lines) => {
				assert.match(lines.join("\n"), /Tools.*\(2\)/);
			}),
		},
	} as unknown as ExtensionCommandContext;
	await paletteCommand(false, host)("", ctx);
	assert.deepEqual(host.getActiveTools(), ["write"]);
	const saved = JSON.parse(fs.readFileSync(path.join(f.agentDir, "pi-config-palette-tools.json"), "utf8"));
	assert.deepEqual(saved, { version: 1, overrides: { read: false } });
	assert.deepEqual(f.global(), {});
	assert.deepEqual(errors, []);
});

test("Tools Session mode persists only to this session and survives a palette reload", { timeout: 5000 }, async (t) => {
	const f = fixture(t);
	const manager = SessionManager.create(f.cwd, path.join(f.root, "sessions"));
	manager.appendMessage({ role: "user", content: "test", timestamp: Date.now() });
	const host = {
		...toolHost(),
		appendEntry: (type: string, data: unknown) => { manager.appendCustomEntry(type, data); },
	};
	const errors: string[] = [];
	const preferences = path.join(f.agentDir, "pi-config-palette-tools.json");
	write(preferences, { version: 1, overrides: { read: true } });
	const before = fs.readFileSync(preferences, "utf8");
	const ctx = {
		...f.ctx, sessionManager: manager, mode: "tui",
		reload: () => assert.fail("session tool changes must not reload Pi"),
		ui: {
			notify: (message: string) => { errors.push(message); },
			custom: (factory: Factory) => usePicker(factory, ["3", "\t", " ", "\x1b"]),
		},
	} as unknown as ExtensionCommandContext;
	await paletteCommand(false, host)("", ctx);
	assert.deepEqual(host.getActiveTools(), ["write"]);
	assert.equal(fs.readFileSync(preferences, "utf8"), before);
	const entry = manager.getBranch().find((entry) => entry.type === "custom" && entry.customType === "pi-config-palette/session-tools");
	assert.ok(entry);
	host.setActiveTools(["read", "write"]);
	const events = new Map<string, EventHandler>();
	paletteCommand(false, host, events);
	await events.get("session_start")!({}, ctx);
	assert.deepEqual(host.getActiveTools(), ["write"]);
	const cached = await loadToolItems(host, f.ctx, true);
	assert.equal(cached.find((item) => item.name === "read")!.enabled, true);
	assert.deepEqual(errors, []);
});

test("lifecycle hooks merge sparse preferences and publish an inventory for the shell", async (t) => {
	const f = fixture(t);
	const host = toolHost();
	const events = new Map<string, EventHandler>();
	paletteCommand(false, host, events);
	const errors: string[] = [];
	const ctx = { ...f.ctx, ui: { notify: (message: string) => { errors.push(message); } } } as unknown as ExtensionContext;
	write(path.join(f.agentDir, "pi-config-palette-tools.json"), { version: 1, overrides: { read: false } });
	await events.get("session_start")!({}, ctx);
	assert.deepEqual(host.getActiveTools(), ["write"]);
	const cached = await loadToolItems(host, f.ctx, true);
	assert.equal(cached.length, 2);
	assert.equal(cached.find((item) => item.name === "read")!.enabled, false);
	for (const event of ["session_tree", "before_agent_start"]) {
		host.setActiveTools(["read", "write"]);
		await events.get(event)!({}, ctx);
		assert.deepEqual(host.getActiveTools(), ["write"]);
	}
	const standaloneEvents = new Map<string, EventHandler>();
	paletteCommand(true, host, standaloneEvents);
	host.setActiveTools(["read", "write"]);
	await standaloneEvents.get("session_start")!({}, ctx);
	assert.deepEqual(host.getActiveTools(), ["read", "write"]);
	assert.deepEqual(errors, []);
});

test("shell tool edits use cached inventory and never access live tools", { timeout: 5000 }, async (t) => {
	const f = fixture(t);
	await cacheToolInventory(toolHost(), f.ctx);
	let shutdowns = 0;
	const errors: string[] = [];
	const forbidden: ToolHost = {
		getAllTools: () => assert.fail("shell must not inspect unloaded extensions"),
		getActiveTools: () => assert.fail("shell must not inspect live tools"),
		setActiveTools: () => assert.fail("shell must not change runtime tools"),
	};
	const ctx = {
		...f.ctx, mode: "tui", shutdown: () => { shutdowns++; },
		ui: {
			setFooter() {}, notify: (message: string) => { errors.push(message); },
			custom: (factory: Factory) => usePicker(factory, ["3", " ", "\x1b"]),
		},
	} as unknown as ExtensionCommandContext;
	await paletteCommand(true, forbidden)("", ctx);
	const cached = await loadToolItems(forbidden, f.ctx, true);
	assert.equal(cached.find((item) => item.name === "read")!.enabled, false);
	assert.equal(shutdowns, 1);
	assert.deepEqual(errors, []);
});

test("standalone shuts down after closing, whether or not anything changed", { timeout: 5000 }, async (t) => {
	for (const toggleFirst of [false, true]) {
		await t.test(toggleFirst ? "saved toggle" : "no changes", async (t) => {
			const f = fixture(t);
			const file = path.join(f.agentDir, "skills/example/SKILL.md");
			skill(file, "example");
			let shutdowns = 0;
			let closed = false;
			let footerHidden = false;
			const errors: string[] = [];
			const ctx = {
				...f.ctx, mode: "tui",
				shutdown: () => { assert.ok(closed); shutdowns++; },
				reload: () => assert.fail("standalone must exit, not reload"),
				ui: {
					notify: (message: string) => { errors.push(message); },
					setFooter: (factory: Parameters<ExtensionCommandContext["ui"]["setFooter"]>[0]) => {
						assert.ok(factory);
						const footer = factory({} as Parameters<typeof factory>[0], theme, {} as Parameters<typeof factory>[2]);
						assert.deepEqual(footer.render(96), []);
						footerHidden = true;
					},
					custom: async (factory: Factory) => {
						assert.ok(footerHidden);
						const result = await usePicker(factory, toggleFirst ? [" ", "\x1b"] : ["\x1b"], (lines) => {
							assert.match(lines.join("\n"), /Help with example/);
						});
						closed = true;
						return result;
					},
				},
			} as unknown as ExtensionCommandContext;
			await paletteCommand(true)("", ctx);
			assert.equal(shutdowns, 1);
			assert.equal(byPath(await loadResources(f.ctx), file).enabled, !toggleFirst);
			assert.deepEqual(errors, []);
		});
	}
});

test("project override notes are visible inside Pi but suppressed by the shell command", { timeout: 5000 }, async (t) => {
	for (const standalone of [false, true]) {
		await t.test(standalone ? "shell" : "inside Pi", async (t) => {
			const f = fixture(t);
			const pkg = path.join(f.root, "package");
			skill(path.join(pkg, "skills/example/SKILL.md"), "example");
			write(f.globalFile, { packages: [pkg] });
			write(f.projectFile, { packages: [{ source: pkg, autoload: false, skills: ["-skills/example"] }] });
			let inspected = false;
			const ctx = {
				...f.ctx, mode: "tui", shutdown() {},
				ui: {
					setFooter() {}, notify: (message: string) => assert.fail(message),
					custom: (factory: Factory) => usePicker(factory, ["\x1b"], (lines) => {
						const screen = lines.join("\n");
						assert.match(screen, /example/);
						if (standalone) assert.doesNotMatch(screen, /\(off in project\)/);
						else assert.match(screen, /\(off in project\)/);
						inspected = true;
					}),
				},
			} as unknown as ExtensionCommandContext;
			await paletteCommand(standalone)("", ctx);
			assert.ok(inspected);
		});
	}
});

test("standalone shuts down on configuration errors instead of leaving a Pi prompt", async (t) => {
	const f = fixture(t);
	write(f.globalFile, "{bad json");
	let shutdowns = 0;
	const errors: string[] = [];
	const ctx = {
		...f.ctx, mode: "tui", shutdown: () => { shutdowns++; },
		ui: { setFooter() {}, notify: (message: string) => { errors.push(message); } },
	} as unknown as ExtensionCommandContext;
	await paletteCommand(true)("", ctx);
	assert.equal(shutdowns, 1);
	assert.match(errors[0], /Could not load config/);
});

test("missing git packages are skipped without installation", async (t) => {
	const f = fixture(t);
	delete process.env.PI_OFFLINE;
	write(f.globalFile, { packages: ["git:github.com/example/nonexistent-palette-fixture"] });
	assert.deepEqual(await loadResources(f.ctx), []);
	assert.equal(fs.existsSync(path.join(f.agentDir, "git")), false);
});
