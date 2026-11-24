import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isMcpServerOverride, mcpNamespace, validateMcpServerConfig } from "@earendil-works/pi-mcp";
import { applyEdits, modify } from "jsonc-parser";
import lockfile from "proper-lockfile";
import type { McpItem } from "./items.ts";

type Context = Pick<ExtensionCommandContext, "cwd" | "isProjectTrusted">;
type Fields = Record<string, unknown>;
const isRecord = (value: unknown): value is Fields => value !== null && typeof value === "object" && !Array.isArray(value);
const exposures = new Set(["codemode", "codemode-deferred", "deferred", "direct", "hidden"]);
const isExposure = (value: unknown) => typeof value === "string" && exposures.has(value);
const openFlags = (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

interface Document {
	target: string;
	text: string;
	stat: fs.BigIntStats;
	servers: Fields;
}

function readFileSnapshot(file: string): { target: string; stat: fs.BigIntStats; bytes: Buffer } | undefined {
	try {
		const target = fs.realpathSync(file);
		const fd = fs.openSync(target, fs.constants.O_RDONLY | openFlags);
		try {
			const stat = fs.fstatSync(fd, { bigint: true });
			if (!stat.isFile()) throw new Error(`Expected a regular file at ${file}`);
			return { target, stat, bytes: fs.readFileSync(fd) };
		} finally { fs.closeSync(fd); }
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function readDocument(file: string): Document | undefined {
	const snapshot = readFileSnapshot(file);
	if (!snapshot) return undefined;
	const { target, stat, bytes } = snapshot;
	const text = bytes.toString("utf8");
	let root: unknown;
	try { root = JSON.parse(text.replace(/^\uFEFF/, "")); }
	catch { throw new Error(`Invalid JSON in ${file}`); } // Parser errors can quote credentials.
	if (!isRecord(root) || (root.mcpServers !== undefined && !isRecord(root.mcpServers))) {
		throw new Error(`Expected an object with an mcpServers object in ${file}`);
	}
	return { target, text, stat, servers: root.mcpServers ?? {} };
}

function validServer(name: string, config: Fields, projectDefinition: boolean): boolean {
	const result = validateMcpServerConfig(name, config, { checkMetadataDocumentCallback: (value) => {
		if (!value) return undefined;
		const url = new URL(value);
		return url.hostname !== "[::1]" && url.pathname === "/callback" ? undefined : "Unsupported callback";
	} });
	if (result.kind === "invalid") return false;
	if (config.exposure !== undefined && !isExposure(config.exposure)) return false;
	if (config.toolExposure !== undefined && !(isRecord(config.toolExposure) && Object.values(config.toolExposure).every(isExposure))) return false;
	if (projectDefinition && "url" in config && config.auth) return false;
	if (result.kind === "http" && config.auth !== undefined) {
		const url = new URL(result.config.url);
		return isRecord(config.auth) && typeof config.auth.provider === "string" && !!config.auth.provider &&
			(url.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
	}
	return true;
}

interface Server {
	item: McpItem;
	effective: Fields;
	document: Document;
}

function configFile(ctx: Context, scope: McpItem["scope"]): string {
	if (scope === "user") return path.join(getAgentDir(), "mcp.json");
	if (!ctx.isProjectTrusted()) throw new Error("Project is not trusted; cannot access project MCP configuration.");
	return path.join(ctx.cwd, CONFIG_DIR_NAME, "mcp.json");
}

function readServers(ctx: Context, warn?: (message: string) => void): Map<string, Server> {
	const servers = new Map<string, Server>();
	const namespaces = new Map<string, string>();
	const fileErrors: string[] = [];
	let globalTarget: string | undefined;
	for (const scope of ["user", "project"] as const) {
		if (scope === "project" && !ctx.isProjectTrusted()) continue;
		const source = configFile(ctx, scope);
		let document: Document | undefined;
		try { document = readDocument(source); }
		catch (error) {
			fileErrors.push(error instanceof Error ? error.message : `Cannot read ${source}`);
			continue;
		}
		if (!document) continue;
		if (scope === "user") globalTarget = document.target;
		else if (document.target === globalTarget) continue;
		let skipped = 0;
		for (const [name, entry] of Object.entries(document.servers)) {
			if (!isRecord(entry)) { skipped++; continue; }
			const isOverride = scope === "project" && isMcpServerOverride(entry);
			let effective = entry;
			if (isOverride) {
				const base = servers.get(name);
				if (!base || Object.keys(entry).some((k) => !["enabled", "exposure", "toolExposure"].includes(k))) {
					skipped++; continue;
				}
				effective = { ...base.effective, ...entry };
			}
			const namespace = mcpNamespace(name);
			const owner = namespaces.get(namespace);
			if ((owner !== undefined && owner !== name) || !validServer(name, effective, scope === "project" && !isOverride)) {
				skipped++; continue;
			}
			namespaces.set(namespace, name);
			const enabled = effective.enabled !== false;
			const definitionHash = createHash("sha256").update(JSON.stringify({ ...effective, enabled: undefined })).digest("hex");
			servers.set(name, { effective, document, item: {
				kind: "mcp", id: `mcp:${document.target}:${name}:${definitionHash}`, name, enabled, desired: enabled, mutable: true,
				source, scope, isOverride, description: typeof effective.description === "string" ? effective.description : "",
			} });
		}
		if (skipped) warn?.(`Skipped ${skipped} invalid or conflicting MCP server ${skipped === 1 ? "entry" : "entries"} in ${source}. Check /mcp for details.`);
	}
	if (fileErrors.length) {
		if (!servers.size) throw new Error(fileErrors.join("; "));
		warn?.(fileErrors.join("; "));
	}
	return servers;
}

export async function loadMcpItems(ctx: Context, warn?: (message: string) => void): Promise<McpItem[]> {
	return [...readServers(ctx, warn).values()].map(({ item }) => item).sort((a, b) => a.name.localeCompare(b.name));
}

function patchedConfig(file: string, text: string, name: string, enabled: boolean | undefined): string {
	const json = text.replace(/^\uFEFF/, "");
	const indent = /^([ \t]+)\S/m.exec(json)?.[1];
	const formattingOptions = indent ? {
		insertSpaces: !indent.includes("\t"), tabSize: indent.length, eol: json.includes("\r\n") ? "\r\n" : "\n",
	} : undefined;
	let patched: string;
	try {
		patched = applyEdits(json, modify(json, ["mcpServers", name, "enabled"], enabled, { formattingOptions }));
		if (JSON.parse(patched).mcpServers[name].enabled !== enabled) throw new Error("Ambiguous entry");
	} catch {
		throw new Error(`Cannot safely edit the MCP entry in ${file}; check for duplicate keys.`);
	}
	return (text.startsWith("\uFEFF") ? "\uFEFF" : "") + patched;
}

function sameVersion(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink &&
		a.uid === b.uid && a.gid === b.gid && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function writeConfig(file: string, document: Document, output: string): string | undefined {
	const { target, text, stat } = document;
	const bytes = Buffer.from(output);
	const fd = fs.openSync(target, fs.constants.O_RDWR | openFlags);
	try {
		const opened = fs.fstatSync(fd, { bigint: true });
		if (!opened.isFile()) throw new Error(`Expected a regular file at ${file}`);
		if (opened.nlink > 1n) throw new Error(`Cannot edit hard-linked MCP config ${file} without changing its other links.`);
		if (opened.mode & 0o6000n) throw new Error(`Cannot edit MCP config with setuid or setgid permissions: ${file}`);
		if (!sameVersion(opened, stat) || !fs.readFileSync(fd).equals(Buffer.from(text)) ||
			fs.realpathSync(file) !== target || !sameVersion(fs.lstatSync(target, { bigint: true }), opened)) {
			throw new Error("MCP configuration changed during save. Reopen the palette.");
		}
		// Keep the original inode and its ACL. This is not crash-atomic; don't truncate first.
		try {
			for (let offset = 0; offset < bytes.length;) {
				const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
				if (!written) throw new Error("Write made no progress");
				offset += written;
			}
			if (BigInt(bytes.length) < opened.size) fs.ftruncateSync(fd, bytes.length);
			try { fs.fsyncSync(fd); }
			catch (error) {
				// A flush error doesn't roll back written bytes. Verify the visible state, not durability.
				const current = readFileSnapshot(file);
				if (current?.target !== target || current.stat.dev !== opened.dev || current.stat.ino !== opened.ino ||
					!current.bytes.equals(bytes)) throw error;
				return `MCP config changed in ${file}, but could not be synced to disk. The change may not survive a crash.`;
			}
		} catch (error) {
			throw new Error(`Could not finish saving ${file}: ${error instanceof Error ? error.message : String(error)}. Check the file before retrying.`, { cause: error });
		}
	} finally { fs.closeSync(fd); }
}

export async function saveMcpToggle(ctx: Context, item: McpItem, warn?: (message: string) => void): Promise<McpItem> {
	const changed = () => new Error("MCP configuration changed. Reopen the palette before toggling this server.");
	const file = configFile(ctx, item.scope);
	if (item.source !== file) throw changed();
	const target = fs.realpathSync(file);
	const release = await lockfile.lock(target, { retries: { retries: 30, factor: 1.2, minTimeout: 10, maxTimeout: 100 } });
	try {
		const fresh = readServers(ctx).get(item.name);
		if (!fresh || fresh.item.id !== item.id || fresh.item.source !== file || fresh.item.scope !== item.scope || fresh.item.isOverride !== item.isOverride ||
			fresh.item.enabled !== item.enabled || fresh.document.target !== target || fs.realpathSync(file) !== target) throw changed();
		// Omitting enabled in a project override inherits the global value.
		const output = patchedConfig(file, fresh.document.text, item.name, item.desired && !fresh.item.isOverride ? undefined : item.desired);
		const warning = writeConfig(file, fresh.document, output);
		if (warning) warn?.(warning);
		return { ...fresh.item, enabled: item.desired, desired: item.desired };
	} finally {
		await release();
	}
}
