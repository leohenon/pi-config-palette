import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const launcher = fileURLToPath(new URL("../bin/pi-config-palette.mjs", import.meta.url));

function fixture(t: TestContext) {
	const root = mkdtempSync(path.join(tmpdir(), "pi-palette-cli-"));
	const bin = path.join(root, "bin");
	const cwd = path.join(root, "project with spaces");
	mkdirSync(bin);
	mkdirSync(cwd);
	const preload = path.join(root, "tty.cjs");
	writeFileSync(preload, `
Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stdout, "isTTY", { value: true });
`);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { root, bin, cwd, preload };
}

test("standalone help works without a terminal", () => {
	const result = spawnSync(process.execPath, [launcher, "--help"], { encoding: "utf8" });
	assert.equal(result.status, 0);
	assert.match(result.stdout, /Usage: pi-config-palette/);
});

test("standalone rejects piped use and arguments instead of entering print/model mode", () => {
	const piped = spawnSync(process.execPath, [launcher], { encoding: "utf8" });
	assert.equal(piped.status, 1);
	assert.match(piped.stderr, /requires an interactive terminal/);
	const unknown = spawnSync(process.execPath, [launcher, "unrecognized-prompt"], { encoding: "utf8" });
	assert.equal(unknown.status, 2);
	assert.match(unknown.stderr, /Usage:/);
});

test("standalone forwards safe startup flags, preserves cwd, and resolves a linked executable", (t) => {
	const f = fixture(t);
	const capture = path.join(f.root, "capture.json");
	writeFileSync(path.join(f.bin, "pi"), `#!${process.execPath}
require("node:fs").writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), sentinel: process.env.PALETTE_TEST_SENTINEL }));
process.exit(7);
`, { mode: 0o755 });
	const link = path.join(f.bin, "pi-config-palette");
	symlinkSync(launcher, link);
	const result = spawnSync(process.execPath, ["--require", f.preload, link], {
		cwd: f.cwd, encoding: "utf8",
		env: { ...process.env, PATH: f.bin, CAPTURE_FILE: capture, PALETTE_TEST_SENTINEL: "preserved" },
	});
	assert.equal(result.status, 7);
	const recorded = JSON.parse(readFileSync(capture, "utf8"));
	assert.deepEqual(recorded.args, [
		"--no-session", "--no-extensions", "--no-mcp", "--offline", "--no-tools",
		"-e", fileURLToPath(new URL("../index.ts", import.meta.url)),
		"--config-palette-standalone", "--", "/config-palette",
	]);
	assert.equal(recorded.cwd, realpathSync(f.cwd));
	assert.equal(recorded.sentinel, "preserved");
});

test("standalone reports a missing Pi executable", (t) => {
	const f = fixture(t);
	const result = spawnSync(process.execPath, ["--require", f.preload, launcher], {
		encoding: "utf8", env: { ...process.env, PATH: f.bin },
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Could not start Pi:.*ENOENT/);
});
