import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const server = `
const lines = require("node:readline").createInterface({ input: process.stdin });
lines.on("line", line => {
	const { id, method, params } = JSON.parse(line);
	if (id === undefined) return;
	let result;
	switch (method) {
		case "initialize":
			result = { protocolVersion: params.protocolVersion, serverInfo: { name: "probe", version: "1" }, capabilities: { tools: {} } };
			break;
		case "tools/list":
			result = { tools: [{ name: "ping", description: "Return pong.", inputSchema: { type: "object" } }] };
			break;
		case "tools/call":
			result = { content: [{ type: "text", text: "pong" }] };
			break;
	}
	const response = result ? { result } : { error: { code: -32601, message: "Method not found" } };
	console.log(JSON.stringify({ jsonrpc: "2.0", id, ...response }));
});
`;

test("real Pi removes the MCP tool after OFF + reload and restores it after ON + reload", (t) => {
	const root = mkdtempSync(path.join(tmpdir(), "pi-palette-mcp-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".pi", "agent");
	const cwd = path.join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd);
	writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({
		mcpServers: { probe: { command: process.execPath, args: ["-e", server], exposure: "direct", timeout: 5 } },
	}));

	const fixture = fileURLToPath(new URL("./mcp-lifecycle-session.ts", import.meta.url));
	const run = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), fixture, agentDir], {
		cwd, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
		env: {
			PATH: path.dirname(process.execPath), SystemRoot: process.env.SystemRoot,
			TMPDIR: root, TMP: root, TEMP: root,
			HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1",
		},
	});
	assert.ifError(run.error);
	assert.equal(run.status, 0, run.stderr || run.stdout || `SDK exited with ${run.signal}`);
});
