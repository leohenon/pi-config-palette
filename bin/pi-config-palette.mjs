#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
	console.log("Usage: pi-config-palette\n\nOpen Pi's resource palette in the current project. Close it to return to your shell.");
	process.exit(0);
}
if (args.length) {
	console.error("Usage: pi-config-palette (run it from the project you want to configure)");
	process.exit(2);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
	console.error("pi-config-palette requires an interactive terminal.");
	process.exit(1);
}

const extension = fileURLToPath(new URL("../index.ts", import.meta.url));
const child = spawn("pi", [
	"--no-session", "--no-extensions", "--no-mcp", "--offline", "--no-tools",
	"-e", extension, "--config-palette-standalone", "--", "/config-palette",
], { stdio: "inherit" });

const interrupt = () => child.kill("SIGINT");
const terminate = () => child.kill("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
const cleanup = () => {
	process.off("SIGINT", interrupt);
	process.off("SIGTERM", terminate);
};
child.once("error", (error) => {
	cleanup();
	console.error(`Could not start Pi: ${error.message}`);
	process.exitCode = 1;
});
child.once("exit", (code, signal) => {
	cleanup();
	if (signal) process.kill(process.pid, signal);
	else process.exitCode = code ?? 1;
});
