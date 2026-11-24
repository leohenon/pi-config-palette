import {
	CONFIG_DIR_NAME,
	DefaultPackageManager,
	SettingsManager,
	getAgentDir,
	parseFrontmatter,
	type ExtensionCommandContext,
	type PackageSource,
	type PathMetadata,
	type ResolvedResource,
	type SkillFrontmatter,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { extensionFileName } from "./items.ts";

type ResourceKey = "extensions" | "skills";
type ResourceContext = Pick<ExtensionCommandContext, "cwd" | "isProjectTrusted">;

export interface ResourceItem {
	id: string;
	kind: "extension" | "skill";
	key: ResourceKey;
	name: string;
	description: string;
	path: string;
	relativePath: string;
	source: string;
	scope: PathMetadata["scope"];
	origin: PathMetadata["origin"];
	baseDir: string;
	enabled: boolean;
	desired: boolean;
	mutable: boolean;
	packageRoot?: string;
	packageName?: string;
	projectEnabled?: boolean;
	projectOverrideId?: string;
}

function posixRelative(baseDir: string, filePath: string): string {
	return path.relative(baseDir, filePath).split(path.sep).join("/");
}

function stripExtension(fileName: string): string {
	return fileName.replace(/\.[^.]+$/, "");
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function parseSkillMetadata(filePath: string): { name: string; description: string } {
	const fallback = path.basename(filePath) === "SKILL.md"
		? path.basename(path.dirname(filePath))
		: stripExtension(path.basename(filePath));
	try {
		const { frontmatter } = parseFrontmatter<SkillFrontmatter>(fs.readFileSync(filePath, "utf8"));
		return { name: stringValue(frontmatter.name) || fallback, description: stringValue(frontmatter.description) };
	} catch {
		return { name: fallback, description: "" };
	}
}

function packageMetadata(root: string): { name: string; description: string; filtersSupported: boolean } {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8").replace(/^\uFEFF/, ""));
		const keys = ["extensions", "skills", "prompts", "themes"];
		const declared = keys.filter((key) => Array.isArray(pkg.pi?.[key]) && pkg.pi[key].every((entry: unknown) => typeof entry === "string"));
		// Pi's filter-object fallback can discover convention directories omitted by an
		// explicit manifest. Do not offer a toggle that could load unrelated resources.
		const filtersSupported = declared.length === 0 || keys.every((key) => declared.includes(key) || !fs.existsSync(path.join(root, key)));
		return { name: stringValue(pkg.name) || path.basename(root), description: stringValue(pkg.description), filtersSupported };
	} catch {
		return { name: path.basename(root), description: "", filtersSupported: true };
	}
}

function entrySuffix(relativePath: string): string {
	const parts = stripExtension(relativePath).split("/");
	while (["src", "dist", "lib", "build", "extensions"].includes(parts[0])) parts.shift();
	if (["index", "main", "extension"].includes(parts.at(-1) ?? "")) parts.pop();
	return parts.join("/");
}

function isFile(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function checkSettingsErrors(settings: SettingsManager, operation: string): void {
	const errors = settings.drainErrors();
	if (errors.length > 0) {
		throw new Error(`Failed to ${operation} Pi settings: ${errors.map(({ scope, path: file, error }) =>
			`${scope}${file ? ` (${file})` : ""}: ${error.message}`).join("; ")}`);
	}
}

function createSettings(ctx: ResourceContext, agentDir: string): SettingsManager {
	const settings = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
	checkSettingsErrors(settings, "read");
	return settings;
}

async function resolveInventory(ctx: ResourceContext, agentDir: string, settingsManager: SettingsManager): Promise<ResourceItem[]> {
	const packageManager = new DefaultPackageManager({ cwd: ctx.cwd, agentDir, settingsManager });
	const resolved = await packageManager.resolve(async () => "skip");
	const packages = new Map<string, ReturnType<typeof packageMetadata>>();
	const makeItem = (kind: ResourceItem["kind"], resource: ResolvedResource): ResourceItem => {
		const meta = resource.metadata;
		const baseDir = meta.baseDir ?? (meta.scope === "project" ? path.join(ctx.cwd, CONFIG_DIR_NAME) : agentDir);
		const relativePath = posixRelative(baseDir, resource.path);
		let pkg = meta.packageRoot ? packages.get(meta.packageRoot) : undefined;
		if (meta.packageRoot && !pkg) {
			pkg = packageMetadata(meta.packageRoot);
			packages.set(meta.packageRoot, pkg);
		}
		let info = kind === "skill" ? parseSkillMetadata(resource.path) : { name: extensionFileName(resource.path), description: "" };
		if (kind === "extension" && pkg) {
			const siblings = resolved.extensions.filter((entry) => entry.metadata.packageRoot === meta.packageRoot);
			const suffix = siblings.length > 1 ? entrySuffix(relativePath) : "";
			info = { name: suffix ? `${pkg.name} / ${suffix}` : pkg.name, description: pkg.description };
			// Two generic entrypoints (e.g. src/index.ts and dist/index.js) still need distinct labels.
			if (siblings.length > 1 && siblings.filter((entry) => entrySuffix(posixRelative(baseDir, entry.path)) === suffix).length > 1) {
				info.name = `${pkg.name} / ${relativePath}`;
			}
		}
		return {
			id: `${kind}:${meta.scope}:${meta.source}:${resource.path}`,
			kind,
			key: kind === "extension" ? "extensions" : "skills",
			...info,
			path: resource.path,
			relativePath,
			source: meta.source,
			scope: meta.scope,
			origin: meta.origin,
			baseDir,
			packageRoot: meta.packageRoot,
			packageName: pkg?.name,
			enabled: resource.enabled,
			desired: resource.enabled,
			// Pi ignores filters on local file package sources, and filtering a bare directory
			// fallback makes its extension disappear from discovery instead of disabling it.
			mutable: meta.scope !== "temporary" && (meta.origin !== "package" || (!!pkg?.filtersSupported && isFile(resource.path))),
		};
	};
	return [
		...resolved.extensions.map((resource) => makeItem("extension", resource)),
		...resolved.skills.map((resource) => makeItem("skill", resource)),
	].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) ||
		`${a.source}/${a.relativePath}`.localeCompare(`${b.source}/${b.relativePath}`));
}

function resourceIdentity(item: ResourceItem): string {
	let resolved: string;
	try { resolved = fs.realpathSync(item.path); }
	catch { resolved = path.resolve(item.path); }
	if (process.platform === "win32") resolved = resolved.toLowerCase();
	return `${item.kind}:${resolved}`;
}

async function resolveResources(ctx: ResourceContext, agentDir: string, settings: SettingsManager): Promise<ResourceItem[]> {
	if (!ctx.isProjectTrusted()) return resolveInventory(ctx, agentDir, settings);
	// Resolve the same global snapshot without project settings or autodiscovery.
	// This retains the global edit target even when a project delta masks it.
	const globalSettings = SettingsManager.inMemory(settings.getGlobalSettings(), { projectTrusted: false });
	checkSettingsErrors(globalSettings, "read");
	const [effective, baseline] = await Promise.all([
		resolveInventory(ctx, agentDir, settings),
		resolveInventory(ctx, agentDir, globalSettings),
	]);
	const globalSkills = baseline.filter((item) => item.kind === "skill");
	const globalKeys = new Set(globalSkills.map(resourceIdentity));
	const effectiveSkills = new Map(effective.filter((item) => item.kind === "skill").map((item) => [resourceIdentity(item), item]));
	const globals = globalSkills.map((item) => {
		const project = effectiveSkills.get(resourceIdentity(item));
		return project?.scope === "project"
			? { ...item, projectEnabled: project.enabled, projectOverrideId: project.id }
			: item;
	});
	// Project-only files and real overrides remain independently editable. Missing
	// effective paths and same-name/different-file skills are not boolean overrides.
	return [
		...effective.filter((item) => item.kind !== "skill" || item.scope === "project" || !globalKeys.has(resourceIdentity(item))),
		...globals,
	].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) ||
		`${a.source}/${a.relativePath}`.localeCompare(`${b.source}/${b.relativePath}`));
}

export async function loadResources(ctx: ResourceContext): Promise<ResourceItem[]> {
	const agentDir = getAgentDir();
	return resolveResources(ctx, agentDir, createSettings(ctx, agentDir));
}

function normalizeTarget(target: string, baseDir: string): string {
	const home = process.env.HOME || homedir();
	if (target === "~") target = home;
	else if (target.startsWith("~/")) target = path.join(home, target.slice(2));
	else if (target.startsWith("file://")) target = fileURLToPath(target);
	return path.resolve(baseDir, target);
}

function isExactAlias(entry: string, item: ResourceItem, settingsBaseDir: string): boolean {
	if (!["+", "-", "!"].includes(entry[0])) return false;
	const target = entry.slice(1);
	// ! entries are globs; do not remove broad exclusions. +/- entries are always exact.
	if (entry[0] === "!" && /[*?\[\]{}()]/.test(target)) return false;
	const targets = [path.resolve(item.path)];
	if (item.kind === "skill" && path.basename(item.path) === "SKILL.md") targets.push(path.dirname(item.path));
	return [item.baseDir, settingsBaseDir].some((baseDir) => targets.includes(normalizeTarget(target, baseDir)));
}

function updateTopLevelFilters(filters: string[], changed: ResourceItem[], peers: ResourceItem[], settingsBaseDir: string): string[] {
	const removed = filters.filter((entry) => changed.some((item) => isExactAlias(entry, item, settingsBaseDir)));
	const next = filters.filter((entry) => !removed.includes(entry));
	// An old relative token may cover the same name in both .pi and .agents. Preserve
	// the other resource's state when replacing that ambiguous token with an absolute one.
	for (const peer of peers) {
		if (!changed.some((item) => item.id === peer.id) && removed.some((entry) => isExactAlias(entry, peer, settingsBaseDir))) {
			next.push(`${peer.enabled ? "+" : "-"}${peer.path}`);
		}
	}
	for (const item of changed) next.push(`${item.desired ? "+" : "-"}${item.path}`);
	return [...new Set(next)];
}

function packageSourceOf(source: PackageSource): string {
	return typeof source === "string" ? source : source.source;
}

function updatePackageFilter(packages: PackageSource[], item: ResourceItem): void {
	const index = packages.findIndex((pkg) => packageSourceOf(pkg) === item.source);
	if (index === -1) throw new Error(`Package disappeared from ${item.scope} settings: ${item.source}. Reopen the palette.`);
	const current = packages[index];
	const pkg: Exclude<PackageSource, string> = typeof current === "string" ? { source: current } : { ...current };
	const filters = pkg[item.key];
	// An ordinary [] disables everything, unlike an omitted filter or an empty delta.
	// Positive-only overrides otherwise start from ALL manifest resources. Include dotfiles too.
	const baseline = filters?.length === 0 && pkg.autoload !== false ? ["!**", "!.*"] : (filters ?? []);
	pkg[item.key] = baseline.filter((entry) => !isExactAlias(entry, item, item.baseDir));
	pkg[item.key]!.push(`${item.desired ? "+" : "-"}${item.relativePath}`);
	packages[index] = pkg;
}

export async function applyResourceChanges(ctx: ResourceContext, changed: ResourceItem[]): Promise<void> {
	const pending = changed.filter((item) => item.mutable && item.desired !== item.enabled);
	if (pending.length === 0) return;
	const agentDir = getAgentDir();
	const settingsManager = createSettings(ctx, agentDir);
	const settings = { user: settingsManager.getGlobalSettings(), project: settingsManager.getProjectSettings() };
	// Validate every change before scheduling any writes, including a revoked trust decision.
	for (const item of pending) {
		if (item.scope === "temporary") throw new Error("Temporary resources cannot be persisted");
		if (item.scope === "project" && !ctx.isProjectTrusted()) throw new Error("Project is not trusted; refusing to write project settings");
		if (item.origin === "package" && !(settings[item.scope].packages ?? []).some((pkg) => packageSourceOf(pkg) === item.source)) {
			throw new Error(`Package disappeared from ${item.scope} settings: ${item.source}. Reopen the palette.`);
		}
	}
	const current = await resolveResources(ctx, agentDir, settingsManager);
	const changes = pending.map((item) => {
		const fresh = current.find((resource) => resource.id === item.id);
		if (!fresh?.mutable || fresh.enabled !== item.enabled) throw new Error(`Resource changed or is no longer editable: ${item.name}. Reopen the palette.`);
		return { ...fresh, desired: item.desired };
	});
	const touched = { user: new Set<ResourceKey | "packages">(), project: new Set<ResourceKey | "packages">() };
	for (const scope of ["user", "project"] as const) {
		const scopeChanges = changes.filter((item) => item.scope === scope);
		for (const item of scopeChanges.filter((item) => item.origin === "package")) {
			updatePackageFilter(settings[scope].packages ?? [], item);
			touched[scope].add("packages");
		}
		for (const key of ["extensions", "skills"] as const) {
			const topLevel = scopeChanges.filter((item) => item.origin === "top-level" && item.key === key);
			if (topLevel.length === 0) continue;
			const peers = current.filter((item) => item.scope === scope && item.origin === "top-level" && item.key === key);
			settings[scope][key] = updateTopLevelFilters(settings[scope][key] ?? [], topLevel, peers,
				scope === "project" ? path.join(ctx.cwd, CONFIG_DIR_NAME) : agentDir);
			touched[scope].add(key);
		}
	}
	if (touched.user.has("packages")) settingsManager.setPackages(settings.user.packages!);
	if (touched.project.has("packages")) settingsManager.setProjectPackages(settings.project.packages!);
	if (touched.user.has("extensions")) settingsManager.setExtensionPaths(settings.user.extensions!);
	if (touched.project.has("extensions")) settingsManager.setProjectExtensionPaths(settings.project.extensions!);
	if (touched.user.has("skills")) settingsManager.setSkillPaths(settings.user.skills!);
	if (touched.project.has("skills")) settingsManager.setProjectSkillPaths(settings.project.skills!);
	await settingsManager.flush();
	checkSettingsErrors(settingsManager, "save");
}
