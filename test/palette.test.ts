import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { ConfigPaletteComponent, type PaletteResult } from "../palette.ts";
import type { PaletteItem, ToolSaveMode } from "../items.ts";
import { mcp, resource, tool, theme } from "./fixtures.ts";

const ESC = "\x1b";
const ENTER = "\r";
const SAVE = "\x13";
const TAB = "\t";
const sample = () => [
	resource("alpha"), resource("bravo"), resource("kernel-benchmark"),
	resource("pi-fff", { kind: "extension", key: "extensions" }),
	resource("pi-web-access", { kind: "extension", key: "extensions", enabled: false, desired: false }),
];

const initialItems = new WeakMap<PaletteResult, PaletteItem[]>();

function setup(items: PaletteItem[] = sample(), saveToggle: (item: PaletteItem, mode?: ToolSaveMode) => Promise<PaletteItem | void> = async () => {}, options: ConstructorParameters<typeof ConfigPaletteComponent>[4] = {}) {
	const results: PaletteResult[] = [];
	const writes: PaletteItem[] = [];
	const writeModes: (ToolSaveMode | undefined)[] = [];
	const errors: string[] = [];
	let lastSave: Promise<PaletteItem | void> = Promise.resolve();
	let renders = 0;
	let rows = 24;
	const ui = new ConfigPaletteComponent(items, theme, {
		requestRender: () => renders++, rows: () => rows,
		saveToggle: (item, mode) => {
			writes.push(item);
			writeModes.push(mode);
			lastSave = Promise.resolve().then(() => saveToggle(item, mode));
			return lastSave;
		},
		notifyError: (message) => { errors.push(message); },
	}, (result) => {
		initialItems.set(result, items);
		results.push(result);
	}, options);
	ui.focused = true;
	const text = (width = 96) => ui.render(width).map(stripVTControlCharacters).join("\n");
	const settle = () => lastSave.catch(() => {});
	const key = async (...keys: string[]) => {
		for (const key of keys) {
			ui.handleInput(key);
			await settle();
		}
	};
	return { ui, results, writes, writeModes, errors, text, key, settle, renders: () => renders, resize: (height: number) => rows = height };
}

function changed(result: PaletteResult): PaletteItem[] {
	const before = initialItems.get(result)!;
	return result.items.filter((item) => item.desired !== before.find((initial) => initial.id === item.id)!.enabled);
}

function listedNames(text: string): string[] {
	return text.split("\n").flatMap((line) => {
		const match = line.match(/\[(?: ON|OFF)\] (.*?)\s*│$/);
		return match ? [match[1]] : [];
	});
}

test("Tools lists live tool names, searches, sorts, and saves toggles", async () => {
	const { text, key, writes, results } = setup([
		resource("skill"), tool("alpha", { enabled: false, desired: false }), tool("bravo"), tool("charlie"),
	]);
	await key("3");
	assert.match(text(), /Tools \(3\)/);
	assert.deepEqual(listedNames(text()), ["charlie", "bravo", "alpha"]);
	assert.doesNotMatch(text(), /Coming soon|Cached/);
	await key("s");
	assert.match(text(), /› \[ ON\] bravo/);
	await key("/", "a", "l", "p", "h", "a", ESC);
	assert.deepEqual(listedNames(text()), ["alpha"]);
	await key(ENTER);
	assert.equal(writes.length, 1);
	assert.equal(writes[0].kind, "tool");
	assert.equal(writes[0].name, "alpha");
	assert.equal(writes[0].desired, true);
	assert.match(text(), /› \[ ON\] alpha/);
	await key(ESC, SAVE);
	assert.equal(results[0].savedChanges, true);
});

test("MCP wraps from Skills, shows edit scope, and reuses sort, search, details, and autosave", async () => {
	const { text, key, writes, writeModes, results } = setup([
		mcp("docs", { enabled: false, desired: false, scope: "project", isOverride: true }),
		mcp("issues"), tool("other"),
	]);
	await key("h");
	assert.match(text(), /MCP \(2\)/);
	assert.match(text(), /› \[OFF\] docs  Project/);
	await key("l");
	assert.match(text(), /No global skills/);
	await key("4", "s");
	assert.match(text(), /› \[ ON\] issues  Global/);
	await key("/", "p", "r", "o", "j", ESC, TAB);
	assert.match(text(), /› \[OFF\] docs  Project/);
	assert.doesNotMatch(text(), /issues|Session/);
	await key("d");
	assert.match(text(), /Project override/);
	assert.match(text(), /\/test\/mcp\.json/);
	assert.match(text(), /not necessarily connected/);
	await key(ESC, ENTER);
	assert.match(text(), /› \[ ON\] docs  Project/);
	await key("3", "4");
	assert.match(text(), /\/ proj/);
	await key(" ", SAVE);
	assert.match(text(), /› \[OFF\] docs  Project/);
	assert.deepEqual(writes.map((item) => [item.kind, item.name, item.desired]), [["mcp", "docs", true], ["mcp", "docs", false]]);
	assert.deepEqual(writeModes, [undefined, undefined]);
	assert.equal(results[0].savedChanges, true);
});

test("failed MCP save restores the row, reports the error, and leaves the palette open", async () => {
	const { text, key, errors, results } = setup([mcp("docs")], async () => { throw new Error("read-only"); });
	await key("4", " ");
	assert.match(text(), /› \[ ON\] docs  Global/);
	assert.match(text(), /Save failed/);
	assert.match(errors[0], /Could not save docs: read-only/);
	assert.equal(results.length, 0);
	await key(ESC);
	assert.equal(results[0].savedChanges, false);
});

test("Tools switches Global/Session without affecting skills or changing preferences", async () => {
	const { ui, text, key, writes, writeModes } = setup([
		resource("skill"), tool("read", { savedEnabled: true, sessionEnabled: false, sessionPreference: false, savedPreference: true }),
	], undefined, { toolSessionAvailable: true });
	await key("3");
	assert.match(text(), /› \[ ON\] read/);
	assert.match(text().split("\n").at(-2)!, /Global\s+Session/);
	const active = (label: string) => theme.bg("selectedBg", ` ${theme.style(label, { fg: "accent", bold: true })} `);
	assert.ok(ui.render(96).at(-2)!.includes(active("Global")));
	await key(TAB);
	assert.match(text(), /› \[OFF\] read/);
	assert.ok(ui.render(96).at(-2)!.includes(active("Session")));
	assert.equal(writes.length, 0);
	await key("/", "r", "e", "a", "d", TAB);
	assert.match(text(), /\/ read/);
	assert.match(text(), /› \[ ON\] read/);
	await key(ESC, TAB, ENTER);
	assert.equal(writeModes[0], "session");
	assert.equal(writes[0].kind, "tool");
	assert.equal(writes[0].desired, true);
	await key("1", " ");
	assert.equal(writeModes[1], undefined);
	assert.equal(writes[1].kind, "skill");
});

test("Global skill rows annotate real project differences and update after project toggles", async () => {
	const { ui, text, key, writes } = setup([
		resource("alpha", { id: "global-alpha", projectEnabled: false, projectOverrideId: "project-alpha" }),
		resource("beta", { enabled: false, desired: false, projectEnabled: true }),
		resource("matching", { projectEnabled: true }),
		resource("global-only"),
		resource("alpha", { id: "project-alpha", scope: "project", enabled: false, desired: false }),
		resource("project-only", { scope: "project" }),
	]);
	assert.match(text(), /\[ ON\] alpha  \(off in project\)/);
	assert.match(text(), /\[OFF\] beta  \(on in project\)/);
	assert.doesNotMatch(text(), /matching\s+\(|global-only\s+\(/);
	assert.ok(ui.render(96).some((line) => line.includes(theme.fg("dim", "  (off in project)"))));
	await key(TAB);
	assert.doesNotMatch(text(), /\(off in project\)|\(on in project\)/);
	await key(ENTER, TAB);
	assert.match(text(), /› \[ ON\] alpha\s+│/);
	assert.doesNotMatch(text(), /alpha\s+\(off in project\)/);
	await key(ENTER);
	assert.match(text(), /› \[OFF\] alpha  \(on in project\)/);
	assert.deepEqual(writes.map((item) => item.kind === "skill" ? item.scope : "unexpected"), ["project", "user"]);
});

test("shell presentation suppresses both skill and tool override notes", async () => {
	const { text, key } = setup([
		resource("skill", { projectEnabled: false }),
		tool("read", { savedEnabled: true, sessionEnabled: false, sessionPreference: false }),
	], undefined, { showOverrides: false, showDescription: true, toolsInventory: "cached" });
	assert.match(text(), /\[ ON\] skill/);
	assert.doesNotMatch(text(), /\(off in project\)/);
	await key("3");
	assert.match(text(), /\[ ON\] read/);
	assert.doesNotMatch(text(), /\(off in session\)/);
});

test("Global rows show muted session differences only when the live states disagree", async () => {
	const { ui, text, key } = setup([
		tool("globally-on", { savedEnabled: true, sessionEnabled: false, sessionPreference: false }),
		tool("globally-off", { enabled: false, desired: false, savedEnabled: false, sessionEnabled: true, sessionPreference: true }),
		tool("matching"),
		tool("cached", { inventory: "cached", savedEnabled: true, sessionEnabled: false }),
	], undefined, { toolSessionAvailable: true });
	await key("3");
	assert.match(text(), /\[ ON\] globally-on  \(off in session\)/);
	assert.match(text(), /\[OFF\] globally-off  \(on in session\)/);
	assert.doesNotMatch(text(), /matching\s+\(|cached\s+\(/);
	assert.ok(ui.render(96).some((line) => line.includes(theme.fg("dim", "  (off in session)"))));
	await key(TAB);
	assert.match(text(), /\[OFF\] globally-on/);
	assert.match(text(), /\[ ON\] globally-off/);
	assert.doesNotMatch(text(), /\(off in session\)|\(on in session\)/);
});

test("session-difference hints preserve names and fit narrow rows", async () => {
	const { ui, text, key } = setup([
		tool("a-long-tool-name-".repeat(8), { savedEnabled: true, sessionEnabled: false }),
	], undefined, { toolSessionAvailable: true });
	await key("3");
	assert.match(text(60), /…  \(off in session\)/);
	assert.doesNotMatch(text(24), /in session/);
	assert.match(text(24), /\[ ON\] a-long/);
	for (const width of [4, 12, 24, 40, 60, 96]) {
		for (const line of ui.render(width)) assert.ok(visibleWidth(line) <= width);
	}
});

test("saving a global tool value leaves a session override effective", async () => {
	const original = tool("read", { savedEnabled: false, sessionEnabled: false, savedPreference: false, sessionPreference: false });
	const { text, key, writeModes } = setup([original], async (item) => {
		assert.equal(item.kind, "tool");
		return { ...original, savedPreference: true, savedEnabled: true, enabled: true, desired: true };
	}, { toolSessionAvailable: true });
	await key("3", ENTER);
	assert.deepEqual(writeModes, ["saved"]);
	assert.match(text(), /› \[ ON\] read/);
	await key(TAB);
	assert.match(text(), /› \[OFF\] read/);
});

test("returning to inherited tool state clears stale preference metadata", async () => {
	const { key, results } = setup([
		tool("read", { savedPreference: true, sessionPreference: false, savedEnabled: true, sessionEnabled: false }),
	], async () => tool("read", { savedEnabled: true, sessionEnabled: true }), { toolSessionAvailable: true });
	await key("3", TAB, ENTER, SAVE);
	const item = results[0].items[0];
	assert.equal(item.kind, "tool");
	if (item.kind !== "tool") assert.fail("expected tool");
	assert.equal(item.sessionPreference, undefined);
	assert.equal(item.savedPreference, undefined);
});

test("standalone and ephemeral tool pickers have only a muted Global mode", async () => {
	for (const inventory of ["live", "cached"] as const) {
		const { ui, text, key, writes } = setup([tool("read", { inventory })], undefined, { toolsInventory: inventory });
		await key("3");
		const before = text();
		const footer = ui.render(96).at(-2)!;
		assert.ok(footer.includes(theme.style("Global", { fg: "muted", bold: false })));
		assert.doesNotMatch(footer, /Session/);
		await key(TAB);
		assert.equal(text(), before);
		assert.equal(writes.length, 0);
	}
});

test("tool details explain exposure and cached inventory without invented file metadata", async () => {
	const { text, key, resize } = setup([
		tool("remote", { inventory: "cached", source: "npm:example", sourcePath: "/example/index.ts", exposure: "deferred", capturedAt: "2026-11-13T00:00:00.000Z" }),
	], undefined, { toolsInventory: "cached" });
	resize(60);
	await key("3");
	assert.match(text().split("\n").at(-2)!, /^╰ Global · Cached /);
	await key("d");
	assert.match(text(), /Exposure/);
	assert.match(text(), /deferred/);
	assert.match(text(), /Cached · 2026-11-13/);
	assert.match(text(), /Definition/);
	assert.match(text(), /\/example\/index.ts/);
	assert.match(text().replaceAll("│", "").replace(/\s+/g, " "), /not execution permissions/);
	assert.doesNotMatch(text(), /SKILL\.md/);
});

test("hidden tools are read-only and a missing shell inventory has a useful empty state", async () => {
	const { text, key, writes } = setup([tool("hidden", { exposure: "hidden", mutable: false, enabled: false, desired: false })]);
	await key("3", ENTER, " ");
	assert.match(text(), /› \[OFF\] hidden/);
	assert.equal(writes.length, 0);
	const empty = setup([], undefined, { toolsInventory: "cached", toolsEmptyMessage: "Open /config-palette inside Pi to discover tools" });
	await empty.key("3");
	assert.match(empty.text(), /Open \/config-palette inside Pi to discover tools/);
	assert.match(empty.text().split("\n").at(-2)!, /^╰ Global · Cached /);
});

test("a single dim question mark sits beside the result count", async () => {
	const { ui, text } = setup();
	const footer = ui.render(96).at(-2)!;
	assert.ok(footer.includes(theme.fg("dim", " ?  1/3 ")));
	assert.match(text().split("\n").at(-2)!, /\?  1\/3 ╯$/);
	assert.doesNotMatch(text(), /Switch tabs|Toggle · autosaves|Apply & close/);
	const empty = setup([]);
	assert.match(empty.text().split("\n").at(-2)!, /\? ╯$/);
});

test("help is inline and preserves selection, scope, query, and sort", async () => {
	const { text, key, results, writes } = setup([
		resource("alpha"), resource("bravo", { enabled: false, desired: false }), resource("brisk"),
		resource("delta", { enabled: false, desired: false }), resource("br-project", { scope: "project" }),
	]);
	await key("s", "s", "/", "b", "r", ESC, "k");
	const before = text();
	await key("?");
	assert.match(text(), /╭ Keys /);
	assert.match(text(), /Switch tabs/);
	assert.match(text(), /1 \/ 2 \/ 3 \/ 4\s+Skills \/ Extensions \/ Tools \/ MCP/);
	assert.match(text(), /Space\/Enter\s+Toggle · autosaves/);
	assert.match(text(), /s\s+Sort\s+│/);
	assert.match(text(), /\?\s+Help\s+│/);
	assert.doesNotMatch(text(), /Sort:|ON → OFF → default|Help \/ back/);
	assert.match(text(), /Esc\s+Close/);
	assert.doesNotMatch(text(), /Ctrl\+S|Ctrl\+C|Apply & close|Back \/ clear search \/ close|Search: Esc\/Enter/);
	assert.doesNotMatch(text(), /› \[|\/ br/);
	await key(" ", ENTER, TAB, "s", "h", "l", "1", "2", "3", "4", "d", "/", "j", "k");
	assert.equal(writes.length, 0);
	assert.equal(results.length, 0);
	await key(ESC);
	assert.equal(text(), before);
	await key("?", "?");
	assert.equal(text(), before);
	assert.equal(results.length, 0);
	await key(ESC);
	assert.match(text(), /› \[OFF\] bravo/);
});

test("help returns to the same scrolled details view", async () => {
	const { text, key, results } = setup([resource("alpha", { path: "/" + "long-directory/".repeat(40) + "SKILL.md" })]);
	await key("d", "j", "j", "j", "j", "j");
	const before = text(40);
	await key("?");
	assert.match(text(40), /╭ Keys /);
	await key("j", "j", ESC);
	assert.equal(text(40), before);
	assert.equal(results.length, 0);
});

test("question mark remains text while searching", async () => {
	const { ui, text, key, results } = setup();
	await key("/", "?");
	assert.match(text(), /\/ \?/);
	assert.doesNotMatch(text(), /╭ Keys /);
	assert.ok(ui.render(96).join("\n").includes(CURSOR_MARKER));
	await key(ESC, "?");
	assert.match(text(), /╭ Keys /);
	await key(ESC);
	assert.match(text(), /\/ \?/);
	assert.equal(results.length, 0);
});

test("help works on Tools and empty lists, including Kitty question-mark encodings", async () => {
	for (const question of ["?", "\x1b[63u", "\x1b[47;2u", "\x1b[47:63;2u"]) {
		const { text, key, results } = setup([]);
		await key(question);
		assert.match(text(), /╭ Keys /);
		await key(question);
		assert.match(text(), /No global skills/);
		await key("3", question);
		assert.match(text(), /╭ Keys /);
		await key(ESC);
		assert.match(text(), /No tools/);
		assert.equal(results.length, 0);
	}
});

test("help scrolls on small terminals and never exceeds the available bounds", async () => {
	const { ui, text, key, resize } = setup();
	await key("?");
	resize(12);
	for (let i = 0; i < 100; i++) { await key("j"); text(40); }
	assert.match(text(40), /Help/);
	for (let i = 0; i < 100; i++) { await key("k"); text(40); }
	assert.match(text(40), /Switch tabs/);
	for (const height of [4, 8, 12, 24, 40]) {
		resize(height);
		for (const width of [0, 1, 4, 12, 24, 48, 96]) {
			const lines = ui.render(width);
			assert.ok(lines.length <= height - 2);
			for (const line of lines) assert.ok(visibleWidth(line) <= width);
		}
	}
	await key(ESC);
	assert.match(text(), /› \[ ON\] alpha/);
});

test("Ctrl+S still applies saved changes from help", async () => {
	const { key, results } = setup();
	await key(ENTER, "?", SAVE);
	assert.equal(results[0].action, "apply");
	assert.equal(results[0].savedChanges, true);
});

test("s cycles ON-first, OFF-first, and default order without changing settings", async () => {
	const { text, key, writes } = setup([
		resource("alpha-off", { enabled: false, desired: false }), resource("bravo-on"),
		resource("charlie-off", { enabled: false, desired: false }), resource("delta-on"),
	]);
	assert.deepEqual(listedNames(text()), ["delta-on", "charlie-off", "bravo-on", "alpha-off"]);
	await key("s");
	assert.deepEqual(listedNames(text()), ["charlie-off", "alpha-off", "delta-on", "bravo-on"]);
	assert.match(text(), /› \[ ON\] bravo-on/);
	await key("s");
	assert.deepEqual(listedNames(text()), ["delta-on", "bravo-on", "charlie-off", "alpha-off"]);
	assert.match(text(), /› \[OFF\] alpha-off/);
	await key("s");
	assert.deepEqual(listedNames(text()), ["delta-on", "charlie-off", "bravo-on", "alpha-off"]);
	await key("s");
	assert.deepEqual(listedNames(text()), ["charlie-off", "alpha-off", "delta-on", "bravo-on"]);
	assert.equal(writes.length, 0);
});

test("search ignores ON/OFF sorting and clearing it restores the selected order", async () => {
	const items = [resource("check", { enabled: false, desired: false }), resource("check-fast"), resource("check-safe")];
	const reference = setup(items);
	await reference.key("/", "c", "h", "e", "c", "k");
	const fuzzyOrder = listedNames(reference.text());
	for (const presses of [1, 2]) {
		const { text, key } = setup(items);
		for (let i = 0; i < presses; i++) await key("s");
		const sorted = listedNames(text());
		if (presses === 1) assert.notDeepEqual(sorted, fuzzyOrder);
		await key("/", "c", "h", "e", "c", "k");
		assert.deepEqual(listedNames(text()), fuzzyOrder);
		await key(ESC);
		assert.match(text(), /\/ check/);
		assert.deepEqual(listedNames(text()), fuzzyOrder);
		await key(ESC);
		assert.match(text(), /\/ Search/);
		assert.deepEqual(listedNames(text()), sorted);
	}
});

test("cycling sort or toggling an item cannot override an active query's ranking", async () => {
	const { text, key } = setup([resource("check", { enabled: false, desired: false }), resource("check-fast"), resource("check-safe")]);
	await key("/", "c", "h", "e", "c", "k", ESC);
	const fuzzyOrder = listedNames(text());
	for (let i = 0; i < 3; i++) {
		await key("s");
		assert.deepEqual(listedNames(text()), fuzzyOrder);
	}
	await key("s", ENTER);
	assert.deepEqual(listedNames(text()), fuzzyOrder);
	await key(ENTER);
	assert.deepEqual(listedNames(text()), fuzzyOrder);
	assert.match(text(), /› \[OFF\] check/);
});

test("status sorting refreshes after toggles while keeping the same item selected", async () => {
	const { text, key, writes } = setup([resource("alpha-off", { enabled: false, desired: false }), resource("bravo-on"), resource("charlie-on")]);
	await key("s", ENTER);
	assert.deepEqual(listedNames(text()), ["bravo-on", "alpha-off", "charlie-on"]);
	assert.match(text(), /› \[OFF\] bravo-on/);
	await key(ENTER);
	assert.deepEqual(listedNames(text()), ["alpha-off", "charlie-on", "bravo-on"]);
	assert.match(text(), /› \[ ON\] bravo-on/);
	assert.deepEqual(writes.map((item) => item.name), ["bravo-on", "bravo-on"]);
});

test("a failed sorted toggle restores ordering and selection", async () => {
	const { text, key, errors } = setup([resource("alpha"), resource("bravo", { enabled: false, desired: false })], async () => {
		throw new Error("save failed");
	});
	await key("s");
	const before = listedNames(text());
	await key(ENTER);
	assert.deepEqual(listedNames(text()), before);
	assert.match(text(), /› \[ ON\] alpha/);
	assert.equal(errors.length, 1);
});

test("status sort is independent per tab and retained across skill scopes", async () => {
	const { text, key, writes } = setup([
		resource("user-off", { enabled: false, desired: false }), resource("user-on"),
		resource("project-off", { scope: "project", enabled: false, desired: false }), resource("project-on", { scope: "project" }),
		resource("extension-off", { kind: "extension", key: "extensions", enabled: false, desired: false }),
		resource("extension-on", { kind: "extension", key: "extensions" }),
	]);
	await key("s", TAB);
	assert.match(text(), /› \[ ON\] project-on/);
	await key("l");
	assert.match(text(), /› \[OFF\] extension-off/);
	await key("s");
	assert.match(text(), /› \[ ON\] extension-on/);
	await key("h", TAB);
	assert.match(text(), /› \[ ON\] user-on/);
	await key("l", "s");
	assert.match(text(), /› \[OFF\] extension-off/);
	await key("h");
	assert.match(text(), /› \[ ON\] user-on/);
	assert.equal(writes.length, 0);
});

test("s stays text in search and is harmless on empty lists", async () => {
	const { text, key, writes } = setup();
	await key("/", "s");
	assert.match(text(), /\/ s/);
	await key(ESC, "3");
	const tools = text();
	await key("s");
	assert.equal(text(), tools);
	assert.equal(writes.length, 0);
	const empty = setup([]);
	await empty.key("s", "s");
	assert.match(empty.text(), /No global skills/);
	assert.equal(empty.writes.length, 0);
});

test("tabs show muted parenthesized totals for all resource kinds", async () => {
	const { ui, text, key } = setup();
	assert.match(text().split("\n")[1], /Skills \(3\)\s+Extensions \(2\)\s+Tools/);
	assert.ok(ui.render(96)[1].includes(theme.fg("muted", " (3)")));
	assert.ok(ui.render(96)[1].includes(theme.fg("dim", " (2)")));
	await key("/", "b", "r", "v");
	assert.match(text().split("\n")[1], /Skills \(3\)\s+Extensions \(2\)\s+Tools/);
	assert.match(text(40).split("\n")[1], /Skills\s+Extensions\s+Tools/);
});

test("active top tab is padded and filled, with no underline", async () => {
	const { ui, key } = setup();
	for (const [index, label] of ["Skills", "Extensions", "Tools", "MCP"].entries()) {
		if (index) await key("l");
		const header = ui.render(96)[1];
		const count = theme.fg("muted", [" (3)", " (2)", " (0)", " (0)"][index]);
		const active = theme.style(label, { fg: "accent", bold: true });
		assert.ok(header.includes(theme.bg("selectedBg", `  ${active}${count}  `)));
		assert.ok(!header.includes("\x1b[4m"));
		assert.match(stripVTControlCharacters(ui.render(96)[2]), /^│\s+│$/);
	}
});

test("tab bar drops counts before collapsing to the active tab on narrow screens", async () => {
	const { ui, text, key } = setup();
	assert.match(text(72).split("\n")[1], /Skills \(3\).*Extensions \(2\).*Tools \(0\).*MCP \(0\)/);
	assert.match(text(40).split("\n")[1], /Skills\s+Extensions\s+Tools\s+MCP/);
	assert.doesNotMatch(text(40).split("\n")[1], /\(\d+\)/);
	assert.ok(ui.render(96)[1].includes(theme.style("Tools", { fg: "muted", bold: false })));
	await key("l");
	const narrowHeader = text(24).split("\n")[1];
	assert.match(narrowHeader, /‹ Extensions ›/);
	assert.doesNotMatch(narrowHeader, /Skills|Tools/);
	assert.ok(ui.render(24)[1].includes(theme.getBgAnsi("selectedBg")));
});

test("Tab switches Global and Project only, with the selector in the bottom border", async () => {
	const { ui, text, key } = setup([
		resource("user-skill", { source: "/local/package" }),
		resource("project-skill", { scope: "project", source: "npm:example-skills" }),
		resource("temporary-skill", { scope: "temporary", mutable: false }),
	]);
	const activeScope = (label: string) => assert.ok(ui.render(96).at(-2)!.includes(theme.style(label, { fg: "accent", bold: true })));
	assert.match(text().split("\n").at(-2)!, /^╰\s+Global \(1\)\s+Project \(1\).*1\/1 ╯$/);
	assert.doesNotMatch(text().split("\n").slice(0, -2).join("\n"), /Global \(\d+\)|Project \(\d+\)|All/);
	activeScope("Global");
	assert.match(text(), /› \[ ON\] user-skill/);
	assert.doesNotMatch(text(), /project-skill|temporary-skill/);
	await key(TAB);
	activeScope("Project");
	assert.match(text(), /› \[ ON\] project-skill/);
	assert.doesNotMatch(text(), /user-skill|temporary-skill/);
	assert.match(text(), /Skills \(3\)/);
	assert.match(text(12).split("\n").at(-2)!, /Project/);
	await key(TAB);
	activeScope("Global");
	assert.match(text(), /› \[ ON\] user-skill/);
	assert.doesNotMatch(text(), /project-skill|temporary-skill|All/);
});

test("scope tabs use compact filled selection like the top tabs", async () => {
	const { ui, text, key } = setup([
		resource("user-skill"),
		resource("project-one", { scope: "project" }),
		resource("project-two", { scope: "project" }),
	]);
	const activeCell = (label: string, count: number) => theme.bg("selectedBg",
		` ${theme.style(label, { fg: "accent", bold: true })}${theme.fg("muted", ` (${count})`)} `);
	assert.ok(ui.render(96).at(-2)!.includes(activeCell("Global", 1)));
	assert.match(text().split("\n").at(-2)!, /Global \(1\)\s+Project \(2\)/);
	assert.doesNotMatch(text().split("\n").at(-2)!, /·/);
	await key(TAB);
	assert.ok(ui.render(96).at(-2)!.includes(activeCell("Project", 2)));
	assert.match(text(18).split("\n").at(-2)!, /Project/);
});

test("scope changes keep the fuzzy query and search focus", async () => {
	const { ui, text, key } = setup([
		resource("alpha-user"), resource("beta-user"),
		resource("alpha-project", { scope: "project" }), resource("beta-project", { scope: "project" }),
	]);
	await key("/", "a", "l", "p", "h", "a");
	assert.match(text(), /\/ alpha/);
	assert.match(text(), /› \[ ON\] alpha-user/);
	assert.doesNotMatch(text(), /alpha-project|beta-/);
	await key(TAB);
	assert.match(text(), /\/ alpha/);
	assert.match(text(), /› \[ ON\] alpha-project/);
	assert.doesNotMatch(text(), /alpha-user|beta-/);
	assert.ok(ui.render(96).join("\n").includes(CURSOR_MARKER));
	await key(ESC);
	assert.ok(!ui.render(96).join("\n").includes(CURSOR_MARKER));
});

test("scoped toggles save separately at their original scope", async () => {
	const items = [
		resource("shared", { id: "user-shared", path: "/user/skills/shared/SKILL.md" }),
		resource("shared", { id: "project-shared", scope: "project", path: "/project/.pi/skills/shared/SKILL.md" }),
	];
	const { text, key, results } = setup(items);
	await key(" ", TAB, " ");
	assert.doesNotMatch(text(), /Saving|pending|\*/);
	assert.match(text(), /› \[OFF\] shared/);
	await key(TAB, SAVE);
	assert.equal(results[0].action, "apply");
	assert.deepEqual(changed(results[0]), items.map((item) => ({ ...item, enabled: false, desired: false })));
	assert.equal(results[0].savedChanges, true);
	assert.ok(items.every((item) => item.desired));
});

test("scope is retained when switching tabs and never filters extensions or Tools", async () => {
	const { text, key } = setup([
		resource("user-skill"), resource("project-skill", { scope: "project" }),
		resource("user-extension", { kind: "extension", key: "extensions" }),
		resource("project-extension", { kind: "extension", key: "extensions", scope: "project" }),
	]);
	await key(TAB, "l");
	assert.doesNotMatch(text(), /Global \(\d+\)\s+Project \(\d+\)/);
	assert.match(text(), /\[ ON\] user-extension/);
	assert.match(text(), /\[ ON\] project-extension/);
	const extensions = text();
	await key(TAB);
	assert.equal(text(), extensions);
	await key("l");
	const tools = text();
	assert.doesNotMatch(tools, /Global \(\d+\)\s+Project \(\d+\)/);
	await key(TAB);
	assert.equal(text(), tools);
	await key("h", "h");
	assert.match(text(), /› \[ ON\] project-skill/);
	assert.doesNotMatch(text(), /user-skill/);
});

test("without project skills Global is muted with no count, and Tab does nothing", async () => {
	const { ui, text, key, results, resize } = setup(Array.from({ length: 30 }, (_, i) => resource(`user-${i}`)));
	for (let i = 0; i < 25; i++) await key("k");
	assert.match(text(), /› \[ ON\] user-25/);
	const footer = ui.render(96).at(-2)!;
	assert.match(stripVTControlCharacters(footer), /^╰ Global ─/);
	assert.doesNotMatch(stripVTControlCharacters(footer), /Global \(/);
	assert.ok(footer.includes(theme.style("Global", { fg: "muted", bold: false })));
	assert.ok(!footer.includes(theme.getFgAnsi("accent")));
	assert.ok(!footer.includes(theme.getBgAnsi("selectedBg")));
	assert.doesNotMatch(footer, /Project/);
	const before = text();
	await key(TAB);
	assert.equal(text(), before);
	resize(12);
	assert.match(text(), /› \[ ON\] user-25/);
	await key(SAVE);
	assert.deepEqual(changed(results[0]), []);
});

test("a project-only skill list starts in Project with a muted non-toggleable label", async () => {
	const { ui, text, key } = setup([resource("project-skill", { scope: "project", enabled: false, desired: false })]);
	assert.match(text(), /› \[OFF\] project-skill/);
	const footer = ui.render(96).at(-2)!;
	assert.match(stripVTControlCharacters(footer), /^╰ Project \(1\)/);
	assert.ok(footer.includes(theme.style("Project", { fg: "muted", bold: false })));
	assert.ok(!footer.includes(theme.getBgAnsi("selectedBg")));
	assert.doesNotMatch(footer, /Global/);
	const before = text();
	await key(TAB);
	assert.equal(text(), before);
});

test("description and provenance appear only in the d details view", async () => {
	const { text, key } = setup([
		resource("caveman", { packageName: "pi-caveman", source: "git:github.com/v2nic/pi-caveman" }),
		resource("project-helper", { scope: "project", packageName: "@example/skills", source: "npm:@example/skills" }),
	]);
	assert.doesNotMatch(text(), /Instructions for|pi-caveman|git:github|SKILL\.md/);
	await key("d");
	assert.match(text(), /Instructions for caveman/);
	assert.match(text(), /pi-caveman/);
	assert.match(text(), /git:github/);
	await key("d", TAB);
	assert.doesNotMatch(text(), /Instructions for|@example|npm:|SKILL\.md/);
	await key("d");
	assert.match(text(), /Instructions for project-helper/);
	assert.match(text(), /npm:@example\/skills/);
});

test("standalone description has a divider and breathing room, wraps, and follows selection", async () => {
	const { text, key } = setup([
		resource("alpha", { description: "A helpful description that wraps across multiple terminal lines. ".repeat(5), packageName: "hidden-package" }),
		resource("bravo", { description: "Another description." }),
	], undefined, { showDescription: true });
	const lines = text(48).split("\n");
	const searchIndex = lines.findIndex((line) => /^│ \/ /.test(line));
	assert.match(lines[searchIndex + 1], /^│\s+│$/);
	assert.match(lines[searchIndex + 2], /^│ ─+ │$/);
	assert.match(lines[searchIndex + 3], /^│\s+│$/);
	assert.match(lines[searchIndex + 4], /A helpful description/);
	assert.match(lines[searchIndex + 5], /…\s+│$/);
	assert.match(lines[searchIndex + 6], /^│\s+│$/);
	assert.match(lines[searchIndex + 7], /^╰ Global /);
	assert.doesNotMatch(text(), /hidden-package|SKILL\.md/);
	await key("k");
	assert.match(text(), /Another description\./);
	assert.doesNotMatch(text(), /A helpful description/);
});

test("standalone descriptions fit small terminals and disappear for empty results", async () => {
	const { ui, text, key, resize } = setup([
		resource("日本語", { description: "Wide 🧪 日本語 description ".repeat(50) }),
	], undefined, { showDescription: true });
	for (const height of [4, 8, 12, 16, 24, 40]) {
		resize(height);
		for (const width of [0, 4, 12, 24, 48, 96]) {
			const lines = ui.render(width);
			assert.ok(lines.length <= height - 2);
			for (const line of lines) assert.ok(visibleWidth(line) <= width);
		}
	}
	await key("/", "z", "z", "z");
	assert.match(text(), /No matches/);
	assert.doesNotMatch(text(), /Wide 🧪/);
});

test("main footer has only search, a gap, scope/position, and external separation", async () => {
	const { text } = setup([resource("alpha", { description: "A readable description that wraps across multiple lines. ".repeat(10), packageName: "pi-example" })]);
	const lines = text(48).split("\n");
	const searchIndex = lines.findIndex((line) => /^│ \/ /.test(line));
	assert.match(lines[searchIndex + 1], /^│\s+│$/);
	assert.match(lines[searchIndex + 2], /^╰ Global .*1\/1 ╯$/);
	assert.equal(lines[searchIndex + 3], "");
	assert.equal(lines.length, searchIndex + 4);
	assert.doesNotMatch(text(), /A readable description|pi-example/);
});

test("d opens metadata; d, Escape and Enter return without closing the palette", async () => {
	const item = resource("caveman", { packageName: "pi-caveman", source: "git:github.com/v2nic/pi-caveman" });
	const { text, key, results } = setup([item]);
	await key(" ");
	const before = text();
	for (const close of ["d", ESC, ENTER]) {
		await key("d");
		assert.match(text(), /Details/);
		assert.match(text(), /git:github.com\/v2nic\/pi-caveman/);
		assert.ok(text().includes(item.path));
		await key(" ", TAB, "l"); // Inspection cannot toggle, change scope, or switch tabs.
		await key(close);
		assert.equal(text(), before);
		assert.equal(results.length, 0);
	}
	await key(SAVE);
	assert.deepEqual(changed(results[0]).map((entry) => entry.name), ["caveman"]);
});

test("full metadata scrolls to long paths and stays within terminal bounds", async () => {
	const item = resource("日本語 🧪 details", { path: "/" + "very-long-directory/".repeat(30) + "TAIL.md" });
	const { ui, text, key, resize } = setup([item]);
	await key("d");
	resize(12);
	for (let i = 0; i < 100; i++) {
		await key("j");
		text(40);
	}
	assert.match(text(40), /TAIL\.md/);
	for (let i = 0; i < 100; i++) {
		await key("k");
		text(40);
	}
	assert.match(text(40), /日本語 🧪 details/);
	for (const height of [4, 8, 12, 24, 40]) {
		resize(height);
		for (const width of [0, 1, 4, 12, 40, 96]) {
			const lines = ui.render(width);
			assert.ok(lines.length <= height - 2);
			for (const line of lines) assert.ok(visibleWidth(line) <= width);
		}
	}
});

test("d remains text during search and does nothing without a selected resource", async () => {
	const { text, key } = setup([resource("debug")]);
	await key("/", "d");
	assert.match(text(), /\/ d/);
	assert.doesNotMatch(text(), /Details/);
	await key(ESC, "3", "d");
	assert.match(text(), /No tools/);
	assert.doesNotMatch(text(), /Details/);
	const empty = setup([]);
	await empty.key("d");
	assert.match(empty.text(), /No global skills/);
	assert.doesNotMatch(empty.text(), /Details/);
});

test("fixed-width badges precede names; status colors do not change with selection", async () => {
	const { ui, text, key } = setup([
		resource("enabled"),
		resource("disabled", { enabled: false, desired: false }),
	]);
	const rows = text().split("\n");
	const on = rows.find((line) => line.includes("[ ON] enabled"))!;
	const off = rows.find((line) => line.includes("[OFF] disabled"))!;
	assert.equal(on.indexOf("enabled"), off.indexOf("disabled"));
	assert.ok(ui.render(96).find((line) => line.includes("enabled"))!.includes(theme.fg("success", "[ ON]")));
	await key("k");
	const selectedOff = ui.render(96).find((line) => line.includes("disabled"))!;
	assert.ok(selectedOff.includes(theme.getBgAnsi("selectedBg")));
	assert.ok(selectedOff.includes(theme.fg("muted", "[OFF]")));
	assert.ok(selectedOff.includes(theme.style("disabled", { fg: "muted", bold: true })));
	assert.ok(!selectedOff.includes(theme.getFgAnsi("success")));
});

test("autosaves show no saving label or asterisk, including while writing", async () => {
	const { ui, text, key, settle } = setup([resource("a-very-long-resource-name-".repeat(5))]);
	ui.handleInput(" ");
	const row = text(40).split("\n").find((line) => line.includes("› [OFF]"))!;
	assert.match(row, /…\s*│$/);
	assert.doesNotMatch(text(), /Saving|\*/);
	await settle();
	assert.doesNotMatch(text(40), /Saving|\*/);
	await key(" ");
	assert.doesNotMatch(text(40), /\*/);
});

test("first result starts one blank line above search, with jk and arrows following visual direction", async () => {
	const { text, key } = setup();
	const lines = () => text().split("\n");
	const searchIndex = lines().findIndex((line) => /^│ \/ /.test(line));
	assert.match(lines()[searchIndex - 2], /› \[ ON\] alpha/);
	assert.match(lines()[searchIndex - 3], /\[ ON\] bravo/);
	assert.match(lines()[searchIndex - 4], /\[ ON\] kernel-benchmark/);
	await key("j");
	assert.match(lines()[searchIndex - 2], /› \[ ON\] alpha/);
	await key("k");
	assert.match(lines()[searchIndex - 3], /› \[ ON\] bravo/);
	await key("\x1b[A");
	assert.match(lines()[searchIndex - 4], /› \[ ON\] kernel-benchmark/);
	await key("\x1b[B", "j");
	assert.match(lines()[searchIndex - 2], /› \[ ON\] alpha/);
});

test("best fuzzy match stays selected nearest search as the result set shrinks", async () => {
	const { text, key } = setup();
	await key("k", "/", "b", "r", "v");
	const lines = text().split("\n");
	const searchIndex = lines.findIndex((line) => /^│ \/ /.test(line));
	assert.match(lines[searchIndex - 2], /› \[ ON\] bravo/);
	assert.match(lines[searchIndex - 3], /^│\s+│$/);
	await key(ESC, "l");
	const extensionLines = text().split("\n");
	assert.match(extensionLines[searchIndex - 2], /› \[ ON\] pi-fff/);
});

test("Enter and Space save immediately without closing; Ctrl+S applies runtime changes", async () => {
	const { text, key, results, writes } = setup();
	await key(ENTER);
	assert.equal(writes.length, 1);
	assert.equal(writes[0].desired, false);
	assert.match(text(), /› \[OFF\] alpha/);
	assert.doesNotMatch(text(), /Saving|\*/);
	assert.equal(results.length, 0);
	await key(" ");
	assert.match(text(), /› \[ ON\] alpha/);
	assert.doesNotMatch(text(), /pending/);
	assert.equal(results.length, 0);
	await key(ENTER, SAVE);
	assert.equal(results[0].action, "apply");
	assert.deepEqual(changed(results[0]).map((item) => item.name), ["alpha"]);
});

test("closing during a save waits for it and repeated toggles cannot race", async () => {
	for (const close of [ESC, SAVE, "\x03"]) {
		let release!: () => void;
		const saving = new Promise<void>((resolve) => { release = resolve; });
		const { ui, results, writes, settle } = setup(undefined, () => saving);
		ui.handleInput(ENTER);
		ui.handleInput(" ");
		assert.equal(writes.length, 1);
		ui.handleInput(close);
		assert.equal(results.length, 0);
		release();
		await settle();
		assert.equal(results.length, 1);
		assert.equal(results[0].savedChanges, true);
		assert.equal(results[0].items[0].enabled, false);
		assert.equal(results[0].items[0].desired, false);
	}
});

test("save failure rolls back the toggle, stays open, and allows retry", async () => {
	let attempts = 0;
	const { ui, text, key, results, errors, settle } = setup(undefined, async () => {
		if (attempts++ === 0) throw new Error("disk is full");
	});
	ui.handleInput(ENTER);
	ui.handleInput(ESC);
	await settle();
	assert.equal(results.length, 0);
	assert.match(errors[0], /Could not save alpha: disk is full/);
	assert.match(text(), /Save failed/);
	assert.match(text(), /› \[ ON\] alpha/);
	assert.doesNotMatch(text(), /\*/);
	await key(ENTER);
	assert.doesNotMatch(text(), /Save failed/);
	assert.match(text(), /› \[OFF\] alpha/);
	await key(ESC);
	assert.equal(results[0].savedChanges, true);
});

test("closing without toggles requests no runtime reload", async () => {
	const { key, results, writes } = setup();
	await key(ESC);
	assert.equal(results[0].action, "apply");
	assert.equal(results[0].savedChanges, false);
	assert.equal(writes.length, 0);
});

test("Ctrl+S can close and apply saved changes from search or details", async () => {
	for (const open of ["/", "d"]) {
		const { key, results } = setup();
		await key(ENTER, open, SAVE);
		assert.equal(results[0].action, "apply");
		assert.deepEqual(changed(results[0]).map((item) => item.name), ["alpha"]);
	}
});

test("starts on skills; jk navigates and space saves a toggle", async () => {
	const { text, key, results, renders } = setup();
	assert.match(text(), /› \[ ON\] alpha/);
	assert.doesNotMatch(text(), /› \[ ON\] pi-fff/);
	await key("k", " ");
	assert.match(text(), /› \[OFF\] bravo/);
	assert.doesNotMatch(text(), /Saving|pending|\*/);
	await key(SAVE);
	assert.equal(results[0].action, "apply");
	assert.deepEqual(changed(results[0]).map((item) => item.name), ["bravo"]);
	assert.equal(renders(), 3);
});

test("1-4 switch directly to palette tabs while preserving tab state", async () => {
	const { text, key, writes, results } = setup();
	await key("/", "b", "r", ESC, "2", "k");
	assert.match(text(), /› \[OFF\] pi-web-access/);
	await key("3");
	assert.match(text(), /No tools/);
	await key("1");
	assert.match(text(), /\/ br/);
	assert.match(text(), /› \[ ON\] bravo/);
	await key("2");
	assert.match(text(), /› \[OFF\] pi-web-access/);
	await key("h");
	assert.match(text(), /\/ br/);
	await key("\x1b[52u");
	assert.match(text(), /No configured MCP servers/);
	await key("\x1b[51u");
	assert.match(text(), /No tools/);
	await key("\x1b[49u");
	assert.match(text(), /› \[ ON\] bravo/);
	assert.equal(writes.length, 0);
	assert.equal(results.length, 0);
});

test("digits remain literal input while searching", async () => {
	const { text, key, writes } = setup([resource("skill-1234")]);
	await key("/", "1", "2", "3", "4");
	assert.match(text(), /\/ 1234/);
	assert.match(text(), /› \[ ON\] skill-1234/);
	assert.equal(writes.length, 0);
});

test("hl cycles tabs and preserves selection and saved changes", async () => {
	const { text, key, results } = setup();
	await key("k", " ", "l");
	assert.match(text(), /› \[ ON\] pi-fff/);
	await key("k", " ", "h");
	assert.match(text(), /› \[OFF\] bravo/);
	await key("l");
	assert.match(text(), /› \[ ON\] pi-web-access/);
	await key(SAVE);
	assert.deepEqual(changed(results[0]).map((item) => item.name), ["bravo", "pi-web-access"]);
});

test("empty Tools supports navigation without writing settings", async () => {
	const { text, key, results } = setup();
	await key("3");
	assert.match(text(), /No tools/);
	await key("j", "k", "/", " ", ENTER);
	assert.equal(results.length, 0);
	assert.ok(!text().includes(CURSOR_MARKER));
	assert.doesNotMatch(text(), /pending/);
	await key(SAVE);
	assert.deepEqual(changed(results[0]), []);
});

test("/ enters fuzzy search; Escape preserves the filter and returns to navigation", async () => {
	const { ui, text, key, results } = setup();
	await key("/", "k", "b", "m");
	assert.match(text(), /› \[ ON\] kernel-benchmark/);
	assert.doesNotMatch(text(), /› \[ ON\] alpha/);
	assert.ok(ui.render(96).join("\n").includes(CURSOR_MARKER));
	await key(ESC);
	assert.equal(results.length, 0);
	assert.ok(!text().includes(CURSOR_MARKER));
	assert.match(text(), /\/ kbm/);
	assert.ok(!ui.render(96).join("\n").includes(CURSOR_MARKER));
	await key(" ", SAVE);
	assert.deepEqual(changed(results[0]).map((item) => item.name), ["kernel-benchmark"]);
});

test("two Escapes leave search and clear it; a third closes the palette", async () => {
	const { text, key, results } = setup();
	await key("/", "k", "b", "m");
	assert.match(text(), /› \[ ON\] kernel-benchmark/);
	await key(ESC);
	assert.match(text(), /\/ kbm/);
	assert.equal(results.length, 0);
	await key(ESC);
	assert.match(text(), /\/ Search/);
	assert.match(text(), /› \[ ON\] alpha/);
	assert.match(text(), /\[ ON\] bravo/);
	assert.equal(results.length, 0);
	await key(ESC);
	assert.equal(results[0].action, "apply");
});

test("Escape clears an active filter during a save instead of queuing a close", async () => {
	let release!: () => void;
	const saving = new Promise<void>((resolve) => { release = resolve; });
	const { ui, text, key, results, settle } = setup(undefined, () => saving);
	await key("/", "b", "r", "v", ESC);
	ui.handleInput(" ");
	ui.handleInput(ESC);
	assert.match(text(), /\/ Search/);
	release();
	await settle();
	assert.equal(results.length, 0);
	assert.match(text(), /\[OFF\] bravo/);
	await key(SAVE);
	assert.equal(results[0].savedChanges, true);
});

test("search sits below the list without jumping between modes", async () => {
	const { text, key, resize } = setup();
	for (const height of [18, 24, 40]) {
		resize(height);
		const lines = text().split("\n");
		const searchIndex = lines.findIndex((line) => /^│ \/ /.test(line));
		const listIndex = lines.findIndex((line) => line.includes("› [ ON] alpha"));
		assert.equal(searchIndex, listIndex + 2);
		assert.match(lines[searchIndex - 1], /^│\s+│$/);
		assert.doesNotMatch(text(), /Instructions for alpha/);
		assert.equal(lines.at(-1), "");
		assert.match(lines[searchIndex], /^│ \/ Search\s+│$/);
		await key("/");
		const searchLines = text().split("\n");
		assert.equal(searchLines.length, lines.length);
		assert.ok(searchLines[searchIndex].includes(CURSOR_MARKER));
		assert.equal(searchLines.at(-1), "");
		await key(ESC);
		assert.match(text().split("\n")[searchIndex], /^│ \/ Search\s+│$/);
	}
});

test("footer hints are absent from navigation, search, and Tools", async () => {
	const { text, key } = setup();
	const noHints = () => assert.doesNotMatch(text(), /hjkl|space toggle|enter save|esc close|navigate|hl tabs/);
	noHints();
	await key("/", "b");
	noHints();
	assert.match(text(), /› \[ ON\] bravo/);
	await key(ESC, "3");
	noHints();
	assert.match(text(), /No tools/);
});

test("search has no mode indicator in either state", async () => {
	const { text, key } = setup();
	assert.doesNotMatch(text(), /NORMAL|INSERT/);
	await key("/", "b");
	assert.doesNotMatch(text(), /NORMAL|INSERT/);
	await key(ESC);
	assert.doesNotMatch(text(), /NORMAL|INSERT/);
});

test("hjkl, spaces, and pasted input are text in search, never actions", async () => {
	const { text, key, results } = setup([resource("hjkl two words")]);
	await key("/", "h", "j", "k", "l", " ", "\x1b[200~two words\x1b[201~");
	assert.match(text(), /\/ hjkl two words/);
	assert.match(text(), /› \[ ON\] hjkl two words/);
	assert.equal(results.length, 0);
	await key(ENTER);
	assert.equal(results.length, 0);
	assert.ok(!text().includes(CURSOR_MARKER));
	await key(SAVE);
	assert.deepEqual(changed(results[0]), []);
});

test("each tab retains its own filter", async () => {
	const { text, key } = setup();
	await key("/", "b", "r", "v", ESC, "l");
	assert.match(text(), /› \[ ON\] pi-fff/);
	assert.doesNotMatch(text(), /\/ brv/);
	await key("/", "w", "e", "b", ESC, "h");
	assert.match(text(), /\/ brv/);
	assert.match(text(), /› \[ ON\] bravo/);
	await key("l");
	assert.match(text(), /\/ web/);
	assert.match(text(), /› \[OFF\] pi-web-access/);
});

test("normal typing is ignored; Escape applies saved changes without mutating the discovery snapshot", async () => {
	const items = sample();
	const { text, key, results } = setup(items);
	await key("z", "a", "i");
	assert.ok(!text().includes(CURSOR_MARKER));
	assert.match(text(), /\/ Search/);
	await key(" ", ESC);
	assert.equal(results[0].action, "apply");
	assert.equal(items[0].desired, true);
	await key(SAVE);
	assert.equal(results.length, 1);
});

test("read-only entries cannot toggle", async () => {
	const { text, key, results } = setup([resource("locked", { mutable: false })]);
	assert.match(text(), /› \[ ON\] locked/);
	await key("d");
	assert.match(text(), /Read-only/);
	await key(ESC, " ", ENTER);
	assert.equal(results.length, 0);
	assert.doesNotMatch(text(), /pending/);
	await key(SAVE);
	assert.deepEqual(changed(results[0]), []);
});

test("a second toggle saves the original state again", async () => {
	const { text, key, results } = setup();
	await key(" ", " ");
	assert.doesNotMatch(text(), /pending/);
	await key(SAVE);
	assert.deepEqual(changed(results[0]), []);
});

test("empty tabs and no-match filters remain navigable", async () => {
	const { text, key, results } = setup([]);
	assert.match(text(), /No global skills/);
	await key("j", "k", " ", "/", "z");
	assert.match(text(), /No matches/);
	await key(ESC, "l");
	assert.match(text(), /No extensions/);
	await key("l");
	assert.match(text(), /No tools/);
	await key(ESC);
	assert.equal(results[0].action, "apply");
});

test("selection scrolls into view and stays in bounds after resize", async () => {
	const { text, key, resize } = setup(Array.from({ length: 60 }, (_, i) => resource(`skill-${String(i).padStart(2, "0")}`)));
	for (let i = 0; i < 45; i++) await key("k");
	assert.match(text(), /› \[ ON\] skill-45/);
	assert.doesNotMatch(text(), /› \[ ON\] skill-00/);
	resize(12);
	assert.match(text(), /› \[ ON\] skill-45/);
	for (let i = 0; i < 100; i++) await key("k");
	assert.match(text(), /› \[ ON\] skill-59/);
	for (let i = 0; i < 100; i++) await key("j");
	assert.match(text(), /› \[ ON\] skill-00/);
});

test("unicode search supports graphemes and backspace", async () => {
	const { text, key } = setup([resource("日本語"), resource("other")]);
	await key("/", "日", "本", "\x7f");
	assert.match(text(), /\/ 日/);
	assert.match(text(), /› \[ ON\] 日本語/);
});

test("rendering fits narrow/wide widths and short/tall terminals in every mode", async () => {
	const { ui, key, resize } = setup([resource("日本語 🧪 é ".repeat(25), { description: "long description ".repeat(60) }), ...sample()]);
	for (const keys of [[], [TAB], [TAB], [TAB], ["/"], ["\x1b[200~日本語 ".repeat(1) + "long ".repeat(80) + "\x1b[201~"], [TAB], [TAB], [ESC], ["l"], ["l"]]) {
		await key(...keys);
		for (const height of [4, 8, 12, 18, 24, 40]) {
			resize(height);
			for (const width of [0, 1, 3, 4, 10, 24, 40, 64, 80, 96, 140]) {
				const lines = ui.render(width);
				assert.ok(lines.length <= height - 2, `height ${height}: ${lines.length} lines`);
				for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} columns`);
			}
		}
	}
});

test("theme styling includes selected background and no hardcoded UI colors", async () => {
	const { ui } = setup();
	const selected = ui.render(96).find((line) => line.includes("alpha"))!;
	assert.ok(selected.includes(theme.getBgAnsi("selectedBg")));
	assert.ok(selected.includes(theme.getFgAnsi("accent")));
});
