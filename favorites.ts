import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";

const filename = "pi-config-palette-favorites.json";

export async function loadFavorites(file = path.join(getAgentDir(), filename)): Promise<Set<string>> {
	let text: string;
	try {
		text = await fs.readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
		throw error;
	}
	const value: unknown = JSON.parse(text);
	if (!Array.isArray(value) || !value.every((key) => typeof key === "string")) {
		throw new Error(`Expected an array of favorite IDs in ${file}`);
	}
	return new Set(value);
}

export async function saveFavorite(key: string, starred: boolean): Promise<Set<string>> {
	const agentDir = getAgentDir();
	await fs.mkdir(agentDir, { recursive: true });
	const file = path.join(await fs.realpath(agentDir), filename);
	const release = await lockfile.lock(file, {
		realpath: false,
		retries: { retries: 30, factor: 1.2, minTimeout: 10, maxTimeout: 100 },
	});
	try {
		const favorites = await loadFavorites(file);
		if (starred) favorites.add(key);
		else favorites.delete(key);
		const temporary = `${file}.${randomUUID()}.tmp`;
		try {
			await fs.writeFile(temporary, `${JSON.stringify([...favorites], null, 2)}\n`, { flag: "wx", mode: 0o600 });
			await fs.rename(temporary, file);
		} finally {
			await fs.rm(temporary, { force: true }).catch(() => {});
		}
		return favorites;
	} finally {
		await release();
	}
}
