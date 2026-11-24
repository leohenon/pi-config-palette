import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	fuzzyFilter,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type Focusable,
} from "@earendil-works/pi-tui";
import { favoriteKey, toolExtensionName, type PaletteItem, type ToolItem, type ToolSaveMode } from "./items.ts";

export interface PaletteResult {
	action: "apply" | "cancel";
	items: PaletteItem[];
	savedChanges: boolean;
}

interface PaletteHost {
	requestRender(): void;
	rows(): number;
	saveToggle(item: PaletteItem, mode?: ToolSaveMode): Promise<PaletteItem | void>;
	saveFavorite(key: string, starred: boolean): Promise<ReadonlySet<string>>;
	notifyError(message: string): void;
}

type Tab = "skills" | "extensions" | "tools" | "mcp";
type SkillScope = "user" | "project";
interface ViewState {
	input: Input;
	selected: number;
	start: number;
	statusSort?: "on" | "off";
}

const TABS: Tab[] = ["skills", "extensions", "tools", "mcp"];
const TAB_KEYS = ["1", "2", "3", "4"] as const;
const KINDS = { skills: "skill", extensions: "extension", tools: "tool", mcp: "mcp" } as const;
const LABELS = { skills: "Skills", extensions: "Extensions", tools: "Tools", mcp: "MCP" };
const SKILL_SCOPES: SkillScope[] = ["user", "project"];
const SCOPE_LABELS = { user: "Global", project: "Project", temporary: "Temporary" };
const KEY_HELP = [
	["1 / 2 / 3 / 4", "Skills / Extensions / Tools / MCP"],
	["h/l  ←/→", "Switch tabs"],
	["j/k  ↑/↓", "Move / scroll"],
	["g / G", "Jump to top / bottom"],
	["Tab", "Scope / mode"],
	["/", "Search"],
	["Space/Enter", "Toggle · autosaves"],
	["f", "Star / unstar"],
	["s", "Sort"],
	["d", "Details"],
	["Esc", "Close"],
	["?", "Help"],
] as const;

// Metadata is display text, never terminal control sequences.
function singleLine(text: string): string {
	return text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}

export class ConfigPaletteComponent implements Component, Focusable {
	private readonly items: PaletteItem[];
	private readonly extensionNames = new Map<string, string>();
	private readonly views: Record<Tab, ViewState>;
	private readonly scopeCounts: Record<SkillScope, number>;
	private readonly availableScopes: SkillScope[];
	private tab: Tab = "skills";
	private skillScope: SkillScope = "user";
	private toolSaveMode: ToolSaveMode = "saved";
	private mode: "normal" | "search" = "normal";
	private filtered: PaletteItem[] = [];
	private favorites: ReadonlySet<string>;
	private hasFocus = false;
	private closed = false;
	private detailsOpen = false;
	private detailScroll = 0;
	private helpOpen = false;
	private helpScroll = 0;
	private saving = false;
	private savedChanges = false;
	private saveError = false;
	private closeAfterSave: PaletteResult["action"] | undefined;

	constructor(
		items: PaletteItem[],
		private readonly theme: Theme,
		private readonly host: PaletteHost,
		private readonly done: (result: PaletteResult) => void,
		private readonly options: {
			favorites?: ReadonlySet<string>;
			showDescription?: boolean;
			toolsInventory?: "live" | "cached";
			toolsEmptyMessage?: string;
			mcpEmptyMessage?: string;
			showOverrides?: boolean;
			toolSessionAvailable?: boolean;
		} = {},
	) {
		this.favorites = options.favorites ?? new Set();
		for (const item of items) {
			if (item.kind === "extension") this.extensionNames.set(item.path, item.name);
		}
		// Keep the caller's discovery snapshot separate from live saved state.
		this.items = items.map((item) => item.kind === "tool" ? {
			...item,
			savedEnabled: item.savedEnabled ?? item.enabled,
			sessionEnabled: item.sessionEnabled ?? item.enabled,
			enabled: item.savedEnabled ?? item.enabled,
			desired: item.savedEnabled ?? item.enabled,
		} : { ...item });
		this.scopeCounts = {
			user: items.filter((item) => item.kind === "skill" && item.scope === "user").length,
			project: items.filter((item) => item.kind === "skill" && item.scope === "project").length,
		};
		this.availableScopes = SKILL_SCOPES.filter((scope) => this.scopeCounts[scope] > 0);
		if (!this.availableScopes.length) this.availableScopes.push("user");
		this.skillScope = this.availableScopes[0];
		const view = (): ViewState => ({
			input: new Input({ prompt: "/ ", placeholder: "Search", placeholderStyle: (s) => theme.fg("dim", s) }),
			selected: 0,
			start: 0,
		});
		this.views = { skills: view(), extensions: view(), tools: view(), mcp: view() };
		this.updateFilter();
	}

	get focused(): boolean {
		return this.hasFocus;
	}

	set focused(value: boolean) {
		this.hasFocus = value;
		this.syncFocus();
	}

	private get view(): ViewState {
		return this.views[this.tab];
	}

	private syncFocus(): void {
		for (const tab of TABS) {
			this.views[tab].input.focused = this.hasFocus && this.mode === "search" && tab === this.tab;
		}
	}

	private isFavorite(item: PaletteItem): boolean {
		return this.favorites.has(favoriteKey(item));
	}

	private updateFilter(reset = false, selectedId?: string): void {
		const items = this.items.filter((item) =>
			item.kind === KINDS[this.tab] && (item.kind !== "skill" || item.scope === this.skillScope),
		);
		const query = this.view.input.getValue();
		this.filtered = fuzzyFilter(items, query, (item) => {
			const extra = item.kind === "tool" ? `${item.sourcePath ?? ""} ${toolExtensionName(item, this.extensionNames) ?? ""}`
				: item.kind === "mcp" ? SCOPE_LABELS[item.scope] : item.relativePath;
			return `${item.name} ${item.description} ${item.source} ${extra}`;
		});
		// Search always uses fuzzy relevance; otherwise preserve order within each group.
		if (!query.trim()) {
			if (this.view.statusSort) {
				const preferred = this.view.statusSort === "on";
				this.filtered.sort((a, b) => Number(b.desired === preferred) - Number(a.desired === preferred));
			} else if (this.favorites.size) {
				this.filtered.sort((a, b) => Number(this.isFavorite(b)) - Number(this.isFavorite(a)));
			}
		}
		if (reset) {
			this.view.selected = 0;
			this.view.start = 0;
		} else if (selectedId) {
			const index = this.filtered.findIndex((item) => item.id === selectedId);
			if (index >= 0) this.view.selected = index;
		}
		this.view.selected = Math.max(0, Math.min(this.view.selected, this.filtered.length - 1));
	}

	private clearSearch(): boolean {
		if (!this.view.input.getValue()) return false;
		this.view.input.setValue("");
		this.updateFilter(true);
		this.redraw();
		return true;
	}

	private redraw(): void {
		this.syncFocus();
		this.invalidate();
		this.host.requestRender();
	}

	private finish(action: PaletteResult["action"]): void {
		if (this.closed) return;
		if (this.saving) {
			this.closeAfterSave = action;
			return;
		}
		this.closed = true;
		this.done({ action, items: this.items, savedChanges: this.savedChanges });
	}

	private async toggle(item: PaletteItem): Promise<void> {
		if (!item.mutable || this.saving) return;
		item.desired = !item.enabled;
		this.saving = true;
		this.saveError = false;
		if (this.view.statusSort) this.updateFilter(false, this.filtered[this.view.selected]?.id);
		this.redraw();
		try {
			const updated = await this.host.saveToggle({ ...item }, item.kind === "tool" ? this.toolSaveMode : undefined);
			if (item.kind === "tool") {
				if (updated?.kind === "tool") {
					Object.assign(item, updated);
					item.sourcePath = updated.sourcePath;
					item.savedPreference = updated.savedPreference;
					item.sessionPreference = updated.sessionPreference;
				} else if (this.toolSaveMode === "session") {
					item.sessionPreference = item.desired === item.savedEnabled ? undefined : item.desired;
					item.sessionEnabled = item.desired;
				} else {
					item.savedPreference = item.desired;
					item.savedEnabled = item.desired;
					item.sessionEnabled = item.sessionPreference ?? item.desired;
				}
				item.enabled = this.toolState(item);
				item.desired = item.enabled;
			} else if (item.kind === "mcp") {
				if (updated?.kind === "mcp") Object.assign(item, updated);
				item.enabled = item.desired;
			} else {
				if (updated?.kind === "skill" || updated?.kind === "extension") {
					Object.assign(item, updated);
					item.projectEnabled = updated.projectEnabled;
					item.projectOverrideId = updated.projectOverrideId;
				}
				item.enabled = item.desired;
				if (item.kind === "skill") {
					for (const peer of this.items) {
						if (peer.kind !== "skill") continue;
						if (peer.projectOverrideId === item.id) peer.projectEnabled = item.enabled;
						if (peer.id === item.projectOverrideId && item.projectEnabled !== undefined) {
							peer.enabled = peer.desired = item.projectEnabled;
						}
					}
				}
			}
			this.savedChanges = true;
		} catch (error) {
			item.desired = item.enabled;
			this.saveError = true;
			this.host.notifyError(`Could not save ${item.name}: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			if (this.view.statusSort || this.view.input.getValue()) this.updateFilter(false, this.filtered[this.view.selected]?.id);
			this.finishSave();
		}
	}

	private async toggleFavorite(item: PaletteItem): Promise<void> {
		this.saving = true;
		this.saveError = false;
		try {
			const key = favoriteKey(item);
			this.favorites = await this.host.saveFavorite(key, !this.favorites.has(key));
			this.updateFilter(false, item.id);
		} catch (error) {
			this.saveError = true;
			this.host.notifyError(`Could not save favorite for ${item.name}: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.finishSave();
		}
	}

	private finishSave(): void {
		this.saving = false;
		this.redraw();
		const action = this.closeAfterSave;
		this.closeAfterSave = undefined;
		// A failed save stays open so the user sees the error and can retry.
		if (action && !this.saveError) this.finish(action);
	}

	private toolState(item: ToolItem): boolean {
		return (this.toolSaveMode === "session" ? item.sessionEnabled : item.savedEnabled) ?? item.enabled;
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (matchesKey(data, "ctrl+c")) {
			this.finish("cancel");
			return;
		}
		if (matchesKey(data, "ctrl+s")) {
			this.finish("apply");
			return;
		}

		if (this.saving) {
			if (matchesKey(data, "escape") && !this.clearSearch()) this.finish("apply");
			return;
		}

		const helpKey = matchesKey(data, "?") || matchesKey(data, "shift+/");
		if (this.helpOpen) {
			this.handleHelpInput(data, helpKey);
			return;
		}
		if (this.mode === "normal" && helpKey) {
			this.helpOpen = true;
			this.helpScroll = 0;
			this.redraw();
			return;
		}

		if (this.detailsOpen) {
			if (matchesKey(data, "d") || matchesKey(data, "escape") || matchesKey(data, "return")) {
				this.detailsOpen = false;
			} else if (matchesKey(data, "j") || matchesKey(data, "down")) {
				this.detailScroll++;
			} else if (matchesKey(data, "k") || matchesKey(data, "up")) {
				this.detailScroll = Math.max(0, this.detailScroll - 1);
			} else {
				return;
			}
			this.redraw();
			return;
		}

		if (this.tab === "tools" && matchesKey(data, "tab")) {
			if (!this.options.toolSessionAvailable) return;
			const selectedId = this.filtered[this.view.selected]?.id;
			this.toolSaveMode = this.toolSaveMode === "saved" ? "session" : "saved";
			for (const item of this.items) {
				if (item.kind !== "tool") continue;
				item.enabled = item.desired = this.toolState(item);
			}
			this.updateFilter(false, selectedId);
			this.redraw();
			return;
		}

		if (this.tab === "skills" && matchesKey(data, "tab")) {
			if (this.availableScopes.length < 2) return;
			this.skillScope = this.availableScopes[(this.availableScopes.indexOf(this.skillScope) + 1) % this.availableScopes.length];
			this.updateFilter(true);
			this.redraw();
			return;
		}

		if (this.mode === "search") {
			if (matchesKey(data, "escape") || matchesKey(data, "return")) {
				// Keep the filter; neither key saves nor closes while editing.
				this.mode = "normal";
			} else {
				const before = this.view.input.getValue();
				this.view.input.handleInput(data);
				if (this.view.input.getValue() !== before) this.updateFilter(true);
			}
			this.redraw();
			return;
		}

		if (matchesKey(data, "escape")) {
			if (!this.clearSearch()) this.finish("apply");
			return;
		}
		const numberedTab = TAB_KEYS.findIndex((key) => matchesKey(data, key));
		if (numberedTab >= 0) {
			this.tab = TABS[numberedTab];
			this.updateFilter();
		} else if (matchesKey(data, "h") || matchesKey(data, "left") || matchesKey(data, "l") || matchesKey(data, "right")) {
			const direction = matchesKey(data, "h") || matchesKey(data, "left") ? -1 : 1;
			this.tab = TABS[(TABS.indexOf(this.tab) + direction + TABS.length) % TABS.length];
			this.updateFilter();
		} else if (matchesKey(data, "j") || matchesKey(data, "down")) {
			this.view.selected = Math.max(0, this.view.selected - 1);
		} else if (matchesKey(data, "k") || matchesKey(data, "up")) {
			this.view.selected = Math.min(Math.max(0, this.filtered.length - 1), this.view.selected + 1);
		} else if (matchesKey(data, "g")) {
			// Lists are drawn in reverse: index zero is at the bottom.
			this.view.selected = Math.max(0, this.filtered.length - 1);
		} else if (matchesKey(data, "shift+g")) {
			this.view.selected = 0;
		} else if (matchesKey(data, "s")) {
			this.view.statusSort = this.view.statusSort === "on" ? "off"
				: this.view.statusSort === "off" ? undefined : "on";
			this.updateFilter(true);
		} else if (matchesKey(data, "/")) {
			this.mode = "search";
		} else if (matchesKey(data, "d") && this.filtered[this.view.selected]) {
			this.detailsOpen = true;
			this.detailScroll = 0;
		} else if (matchesKey(data, "f")) {
			const item = this.filtered[this.view.selected];
			if (item) void this.toggleFavorite(item);
			return;
		} else if (matchesKey(data, "space") || matchesKey(data, "return")) {
			const item = this.filtered[this.view.selected];
			if (item) void this.toggle(item);
			return;
		} else {
			return;
		}
		this.redraw();
	}

	private handleHelpInput(data: string, helpKey: boolean): void {
		if (helpKey || matchesKey(data, "escape")) {
			this.helpOpen = false;
		} else if (matchesKey(data, "j") || matchesKey(data, "down")) {
			this.helpScroll++;
		} else if (matchesKey(data, "k") || matchesKey(data, "up")) {
			this.helpScroll = Math.max(0, this.helpScroll - 1);
		} else {
			return;
		}
		this.redraw();
	}

	private renderHelpLines(width: number): string[] {
		const th = this.theme;
		const wrap = (s: string) => wrapTextWithAnsi(s, Math.max(1, width));
		const rows = KEY_HELP.flatMap(([key, action]) => width >= 44
			? wrap(th.fg("accent", key.padEnd(14)) + th.fg("muted", action))
			: [...wrap(th.fg("accent", key)), ...wrap(th.fg("muted", `  ${action}`)), ""]);
		return ["", ...rows, ""];
	}

	private renderTabs(width: number): string {
		const th = this.theme;
		const counts: Record<Tab, number> = {
			skills: this.items.filter((item) => item.kind === "skill").length,
			extensions: this.items.filter((item) => item.kind === "extension").length,
			tools: this.items.filter((item) => item.kind === "tool").length,
			mcp: this.items.filter((item) => item.kind === "mcp").length,
		};
		const tabBar = (showCounts: boolean, padding: number) => TABS.map((tab) => {
			const active = tab === this.tab;
			const label = th.style(LABELS[tab], {
				fg: active ? "accent" : "muted", bold: active,
			});
			const count = showCounts
				? th.fg(active ? "muted" : "dim", ` (${counts[tab]})`) : "";
			const space = " ".repeat(padding);
			const cell = space + label + count + space;
			return active ? th.bg("selectedBg", cell) : cell;
		}).join(" ");
		let tabs = tabBar(true, 2);
		if (visibleWidth(tabs) > width) tabs = tabBar(false, 1);
		if (visibleWidth(tabs) > width) {
			tabs = th.bg("selectedBg", th.style(` ‹ ${LABELS[this.tab]} › `, { fg: "accent", bold: true }));
		}
		return tabs;
	}

	private renderRowHint(item: PaletteItem, width: number): string {
		if (item.kind !== "mcp" && this.options.showOverrides === false) return "";
		let hint = "";
		if (item.kind === "mcp") {
			hint = `  ${SCOPE_LABELS[item.scope]}`;
		} else if (item.kind === "tool" && this.toolSaveMode === "saved" && item.inventory === "live" &&
			item.sessionEnabled !== undefined && item.sessionEnabled !== item.desired) {
			hint = item.sessionEnabled ? "  (on in session)" : "  (off in session)";
		} else if (item.kind === "skill" && item.scope === "user" &&
			item.projectEnabled !== undefined && item.projectEnabled !== item.desired) {
			hint = item.projectEnabled ? "  (on in project)" : "  (off in project)";
		}
		const minimumNameWidth = Math.min(8, visibleWidth(singleLine(item.name)));
		return hint && visibleWidth(hint) + minimumNameWidth <= width ? this.theme.fg("dim", hint) : "";
	}

	private renderToolMode(width: number): string {
		const th = this.theme;
		const switchable = this.options.toolSessionAvailable === true;
		const option = (mode: ToolSaveMode) => {
			const active = switchable && this.toolSaveMode === mode;
			const label = th.style(mode === "saved" ? "Global" : "Session", { fg: active ? "accent" : "muted", bold: active });
			if (!switchable) return label;
			return active ? th.bg("selectedBg", ` ${label} `) : ` ${label} `;
		};
		const modes: ToolSaveMode[] = switchable ? ["saved", "session"] : ["saved"];
		const labels = modes.map(option).join(" ");
		const cached = this.options.toolsInventory === "cached" ? th.fg("dim", " · Cached") : "";
		return ` ${visibleWidth(labels + cached) + 2 <= width ? labels + cached : option(this.toolSaveMode)} `;
	}

	private renderContextLabel(width: number): string {
		if (this.tab === "tools") return this.renderToolMode(width);
		if (this.tab === "mcp") return this.theme.fg("muted", " Applies on reload ");
		if (this.tab !== "skills") return "";
		const th = this.theme;
		const switchable = this.availableScopes.length > 1;
		const scopeOption = (scope: SkillScope) => {
			const active = switchable && scope === this.skillScope;
			const label = th.style(SCOPE_LABELS[scope], { fg: active ? "accent" : "muted", bold: active });
			const count = scope !== "user" || switchable
				? th.fg(active ? "muted" : "dim", ` (${this.scopeCounts[scope]})`) : "";
			if (!switchable) return label + count;
			const cell = ` ${label}${count} `;
			return active ? th.bg("selectedBg", cell) : cell;
		};
		const scopes = this.availableScopes.map(scopeOption).join(" ");
		return ` ${visibleWidth(scopes) + 2 <= width ? scopes : scopeOption(this.skillScope)} `;
	}

	private descriptionFallback(item: PaletteItem): string {
		const source = singleLine(item.source);
		if (item.kind === "mcp") return source || "—";
		// "auto" and "local" describe discovery, not where to find the file.
		const namedSource = source === "auto" || source === "local" ? "" : source;
		if (item.kind === "tool") return singleLine(item.sourcePath ?? "") || namedSource || "—";
		return namedSource || singleLine(item.relativePath) || "—";
	}

	render(width: number): string[] {
		if (width < 4) return [truncateToWidth("Config", Math.max(0, width), "")];
		const th = this.theme;
		const inner = width - 2;
		const contentWidth = width - 4;
		const available = Math.max(1, this.host.rows() - 2);
		const border = (s: string) => th.fg("borderMuted", s);
		const fit = (s: string, w = contentWidth) => truncateToWidth(s, Math.max(0, w), "…", true);
		const row = (s = "", selected = false) => {
			const content = ` ${fit(s)} `;
			return border("│") + (selected ? th.bg("selectedBg", content) : content) + border("│");
		};
		const cap = (top: boolean, left = "", right = "") => {
			const rightLabel = visibleWidth(left) + visibleWidth(right) + 2 <= inner ? right : "";
			const leftLabel = truncateToWidth(left, Math.max(0, inner - visibleWidth(rightLabel)), "");
			return border(top ? "╭" : "╰") + leftLabel +
				border("─".repeat(Math.max(0, inner - visibleWidth(leftLabel) - visibleWidth(rightLabel)))) +
				rightLabel + border(top ? "╮" : "╯");
		};
		const status = this.saveError ? th.fg("error", " Save failed ") : "";
		const title = this.helpOpen ? " Keys " : this.detailsOpen ? " Details " : " Config ";
		const top = cap(true, th.fg("text", title), status);
		if (available < 6) return [top, row("Resize terminal"), cap(false), ""].slice(0, available);

		if (this.helpOpen) {
			const body = this.renderHelpLines(contentWidth);
			const pageSize = available - 3;
			this.helpScroll = Math.max(0, Math.min(this.helpScroll, body.length - pageSize));
			const end = Math.min(body.length, this.helpScroll + pageSize);
			const position = body.length > pageSize ? th.fg("dim", ` ${this.helpScroll + 1}–${end}/${body.length} `) : "";
			return [top, ...body.slice(this.helpScroll, end).map((s) => row(s)), cap(false, "", position), ""];
		}

		const selectedItem = this.filtered[this.view.selected];
		if (this.detailsOpen && selectedItem) {
			const extension = selectedItem.kind === "tool" ? toolExtensionName(selectedItem, this.extensionNames) : undefined;
			const wrap = (text: string) => wrapTextWithAnsi(singleLine(text), Math.max(1, contentWidth));
			const field = (label: string, value: string) => [th.fg("dim", label), ...wrap(value).map((s) => th.fg("muted", s)), ""];
			const body = [
				...wrap(selectedItem.name).map((s) => th.bold(s)), "",
				...field("Description", selectedItem.description || "—"),
				...(selectedItem.kind === "tool" ? [
					...(extension ? field("Extension", extension) : []),
					...field("Source", selectedItem.source),
					...(selectedItem.sourcePath ? field("Definition", selectedItem.sourcePath) : []),
					...field("Exposure", selectedItem.exposure + (selectedItem.mutable ? "" : " · Read-only")),
					...field("Inventory", selectedItem.inventory === "cached" ? `Cached · ${selectedItem.capturedAt || "unknown date"}` : "Live session"),
					...field("Global preference", selectedItem.savedPreference === undefined ? "Inherit" : selectedItem.savedPreference ? "ON" : "OFF"),
					...(selectedItem.inventory === "live" ? [
						...field("Session override", selectedItem.sessionPreference === undefined ? "Inherit" : selectedItem.sessionPreference ? "ON" : "OFF"),
						...field("Active in session", selectedItem.sessionEnabled ? "ON" : "OFF"),
					] : []),
					...field("Note", "Session overrides win over Global preferences. These control active tool selection, not execution permissions. Other tools may still call or reactivate deferred tools."),
				] : selectedItem.kind === "mcp" ? [
					...field("Scope", SCOPE_LABELS[selectedItem.scope] + (selectedItem.isOverride ? " override" : "")),
					...field("Config file", selectedItem.source),
					...field("Configured", selectedItem.enabled ? "ON" : "OFF"),
					...field("Note", "ON means enabled in config, not necessarily connected. Use /mcp for connection status and sign-in."),
				] : [
					...field("Scope", SCOPE_LABELS[selectedItem.scope] + (selectedItem.mutable ? "" : " · Read-only")),
					...(selectedItem.packageName ? field("Package", selectedItem.packageName) : []),
					...field("Source", selectedItem.source),
					...field("File", selectedItem.path),
				]),
			];
			const pageSize = available - 3;
			this.detailScroll = Math.max(0, Math.min(this.detailScroll, body.length - pageSize));
			const end = Math.min(body.length, this.detailScroll + pageSize);
			const position = body.length > pageSize ? `${this.detailScroll + 1}–${end}/${body.length}` : "";
			const hint = th.fg("dim", ` ?${position ? `  ${position}` : ""} `);
			return [top, ...body.slice(this.detailScroll, end).map((s) => row(s)), cap(false, "", hint), ""];
		}

		const showSearch = available >= 8;
		const showSpacer = available >= 16;
		const showFooterGap = available >= 10;
		const descriptionRows = this.options.showDescription ? (available >= 16 ? 2 : available >= 12 ? 1 : 0) : 0;
		const padDescription = descriptionRows > 0 && available >= 16;
		const descriptionHeight = descriptionRows + Number(descriptionRows > 0) + (padDescription ? 2 : 0);
		// Include one trailing line to separate this inline picker from Pi's footer.
		const overhead = 4 + (showSearch ? 2 : 0) + Number(showSpacer) + Number(showFooterGap) + descriptionHeight;
		const pageSize = Math.max(1, Math.min(14, available - overhead));
		const view = this.view;
		view.start = Math.max(0, Math.min(view.start, this.filtered.length - pageSize));
		if (view.selected < view.start) view.start = view.selected;
		if (view.selected >= view.start + pageSize) view.start = view.selected - pageSize + 1;

		const lines = [top, row(this.renderTabs(contentWidth))];

		if (showSpacer) lines.push(row());

		const availableNameWidth = Math.max(0, contentWidth - visibleWidth("› [OFF] "));
		let toolNameColumn = 0;
		if (this.tab === "tools" && width >= 48) {
			for (const item of this.filtered) {
				if (item.kind !== "tool" || !toolExtensionName(item, this.extensionNames)) continue;
				const cells = visibleWidth(singleLine(item.name)) + (this.isFavorite(item) ? visibleWidth("★ ") : 0);
				// Don't let one long name squeeze every tag.
				if (cells + 16 <= availableNameWidth) toolNameColumn = Math.max(toolNameColumn, cells);
			}
		}

		// Draw the first/best result at the bottom, nearest search.
		for (let offset = 0; offset < pageSize; offset++) {
			const index = view.start + pageSize - 1 - offset;
			const item = this.filtered[index];
			if (!item) {
				const noItems = this.tab === "skills" ? `No ${SCOPE_LABELS[this.skillScope].toLowerCase()} skills`
					: this.tab === "tools" ? this.options.toolsEmptyMessage || "No tools"
					: this.tab === "mcp" ? this.options.mcpEmptyMessage || "No configured MCP servers" : "No extensions";
				const empty = this.view.input.getValue() ? "No matches" : noItems;
				lines.push(row(!this.filtered.length && offset === Math.floor(pageSize / 2) ? th.fg("muted", empty) : ""));
				continue;
			}
			const selected = index === view.selected;
			const prefix = selected ? th.fg("accent", "› ") : "  ";
			const badge = th.fg(item.desired ? "success" : "muted", item.desired ? "[ ON]" : "[OFF]");
			const leading = `${prefix}${badge} `;
			const star = this.isFavorite(item) ? th.fg("accent", "★ ") : "";
			const starWidth = visibleWidth(star);
			const hint = this.renderRowHint(item, availableNameWidth - starWidth);
			const labelWidth = availableNameWidth - visibleWidth(hint);
			const label = star + th.style(truncateToWidth(singleLine(item.name), Math.max(0, labelWidth - starWidth), "…"), {
				fg: item.desired ? "text" : "muted", bold: selected,
			});
			const extension = toolNameColumn > 0 && item.kind === "tool" ? singleLine(toolExtensionName(item, this.extensionNames) ?? "") : "";
			const padding = toolNameColumn - visibleWidth(label);
			const room = labelWidth - toolNameColumn - 4;
			const attribution = extension && padding >= 0 && room >= Math.min(4, visibleWidth(extension))
				? " ".repeat(padding + 2) + th.fg("dim", `[${truncateToWidth(extension, room, "…")}]`) : "";
			lines.push(row(leading + label + attribution + hint, selected));
		}

		if (showSearch) {
			lines.push(row());
			this.syncFocus();
			const searchWidth = Math.max(1, contentWidth);
			const search = this.mode === "search"
				? this.view.input.render(searchWidth)[0]
				: th.fg("muted", "/ ") + th.fg(this.view.input.getValue() ? "text" : "dim", singleLine(this.view.input.getValue()) || "Search");
			lines.push(row(search));
		}

		if (showFooterGap) lines.push(row());

		if (descriptionRows) {
			lines.push(row(th.fg("borderMuted", "─".repeat(contentWidth))));
			if (padDescription) lines.push(row());
			const preview = singleLine(selectedItem?.description ?? "");
			const wrapped = preview ? wrapTextWithAnsi(preview, Math.max(1, contentWidth))
				: selectedItem ? [this.descriptionFallback(selectedItem)] : [];
			const description = wrapped.slice(0, descriptionRows);
			if (wrapped.length > descriptionRows) {
				description[descriptionRows - 1] = truncateToWidth(description[descriptionRows - 1], Math.max(0, contentWidth - 1), "") + "…";
			}
			for (let i = 0; i < descriptionRows; i++) lines.push(row(th.fg("muted", description[i] || "")));
			if (padDescription) lines.push(row());
		}

		const scopeLabel = this.renderContextLabel(inner);
		const position = this.filtered.length ? `${view.selected + 1}/${this.filtered.length}` : "";
		lines.push(cap(false, scopeLabel, th.fg("dim", ` ?${position ? `  ${position}` : ""} `)), "");
		return lines;
	}

	invalidate(): void {
		for (const tab of TABS) this.views[tab].input.invalidate();
	}
}
