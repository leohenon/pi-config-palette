import assert from "node:assert/strict";
import {
	createAgentSession, createMcpExtension, DefaultResourceLoader, SessionManager,
} from "@earendil-works/pi-coding-agent";
import { loadMcpItems, saveMcpToggle } from "../mcp.ts";

const cwd = process.cwd();
const agentDir = process.argv[2];
assert.ok(agentDir && agentDir === process.env.PI_CODING_AGENT_DIR, "run via mcp-lifecycle.test.ts");

const resourceLoader = new DefaultResourceLoader({
	cwd, agentDir, noContextFiles: true, extensionFactories: [createMcpExtension()],
});
await resourceLoader.reload();
const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, sessionManager: SessionManager.inMemory(cwd) });

async function assertToolPresent(expected: boolean) {
	const runner = session.extensionRunner;
	const mcp = runner.getCommand("mcp");
	assert.ok(mcp, "missing native /mcp");
	await mcp.handler("", runner.createCommandContext());
	const name = "mcp__probe__ping";
	assert.equal(session.getAllTools().some((tool) => tool.name === name), expected, `registered: ${name}`);
	const active = session.state.tools.find((tool) => tool.name === name);
	assert.equal(Boolean(active), expected, `active: ${name}`);
	if (active) {
		const result = await active.execute("probe-call", {});
		assert.deepEqual(result.content, [{ type: "text", text: "pong" }]);
	}
}

try {
	await session.bindExtensions({ onError: (event) => assert.fail(event.error) });
	await assertToolPresent(true);
	for (const enabled of [false, true]) {
		const ctx = session.extensionRunner.createContext();
		const [item] = await loadMcpItems(ctx);
		assert.equal(item?.name, "probe");
		assert.equal(item.enabled, !enabled);
		await saveMcpToggle(ctx, { ...item, desired: enabled });
		await session.reload();
		await assertToolPresent(enabled);
	}
} finally {
	await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	session.dispose();
}
