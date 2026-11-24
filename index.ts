import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConfigPaletteComponent, type PaletteResult } from "./palette.ts";
import { applyResourceChanges, loadResources } from "./resources.ts";
import type { PaletteItem } from "./items.ts";
import { SessionTools } from "./session-tools.ts";
import { loadMcpItems, saveMcpToggle } from "./mcp.ts";

async function openPalette(_args: string, ctx: ExtensionCommandContext, tools: SessionTools, standalone: boolean): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Config requires interactive mode", "error");
		return;
	}

	if (standalone) {
		ctx.ui.setFooter(() => ({ render: () => [], invalidate() {} }));
	}

	let items: PaletteItem[];
	try {
		items = await loadResources(ctx);
	} catch (error) {
		ctx.ui.notify(`Could not load config: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}

	let toolsEmptyMessage = standalone ? "Open /config-palette inside Pi to discover tools" : "No tools";
	try {
		items.push(...await tools.list(ctx, standalone, (warning) => ctx.ui.notify(warning, "warning")));
	} catch (error) {
		toolsEmptyMessage = "Tools unavailable; check the reported error";
		ctx.ui.notify(`Could not load tools: ${error instanceof Error ? error.message : String(error)}`, "error");
	}

	let mcpEmptyMessage: string | undefined;
	try {
		items.push(...await loadMcpItems(ctx, (warning) => {
			mcpEmptyMessage = "No valid MCP servers; check /mcp";
			ctx.ui.notify(warning, "warning");
		}));
	} catch (error) {
		mcpEmptyMessage = "MCP configuration unavailable; check the reported error";
		ctx.ui.notify(`Could not load MCP config: ${error instanceof Error ? error.message : String(error)}`, "error");
	}

	let needsReload = false;
	const result = await ctx.ui.custom<PaletteResult>(
		(tui, theme, _keybindings, done) => new ConfigPaletteComponent(
			items,
			theme,
			{
				requestRender: () => tui.requestRender(),
				rows: () => tui.terminal.rows,
				saveToggle: async (item, mode) => {
					if (item.kind === "tool") {
						return tools.save(ctx, item, mode ?? "saved", standalone);
					} else if (item.kind === "mcp") {
						const saved = await saveMcpToggle(ctx, item, (warning) => ctx.ui.notify(warning, "warning"));
						needsReload = true;
						return saved;
					} else {
						await applyResourceChanges(ctx, [item]);
						needsReload = true;
						try {
							const refreshed = await loadResources(ctx);
							const fresh = refreshed.find((entry) => entry.id === item.id);
							if (fresh) return fresh;
						} catch (error) {
							ctx.ui.notify(`Change saved; could not refresh project state: ${error instanceof Error ? error.message : String(error)}`, "warning");
						}
						return { ...item, enabled: item.desired, projectEnabled: undefined, projectOverrideId: undefined };
					}
				},
				notifyError: (message) => ctx.ui.notify(message, "error"),
			},
			done,
			{
				showDescription: standalone, showOverrides: !standalone,
				toolsInventory: standalone ? "cached" : "live", toolsEmptyMessage, mcpEmptyMessage,
				toolSessionAvailable: !standalone && ctx.sessionManager.getSessionFile() !== undefined,
			},
		),
		{ overlay: false }, // Use the editor slot, like Pi's /resume picker.
	);

	if (standalone || !result.savedChanges || !needsReload) return;
	await ctx.waitForIdle();

	try {
		await ctx.reload();
	} catch (error) {
		ctx.ui.notify(`Saved; reload failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

export default function piConfigPalette(pi: ExtensionAPI): void {
	const tools = new SessionTools(pi);
	pi.registerFlag("config-palette-standalone", {
		type: "boolean", default: false, description: "Exit Pi when the config palette closes",
	});
	const syncTools = async (ctx: ExtensionContext, cache: boolean, reason: "start" | "tree" | "turn") => {
		if (pi.getFlag("config-palette-standalone") === true) return;
		try {
			await tools.restore(ctx, reason);
		} catch (error) {
			ctx.ui.notify(`Could not restore tool preferences: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		if (cache) {
			try {
				await tools.cache(ctx);
			} catch (error) {
				ctx.ui.notify(`Could not cache tool inventory: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		}
	};
	pi.on("session_start", (_event, ctx) => syncTools(ctx, true, "start"));
	pi.on("session_tree", (_event, ctx) => syncTools(ctx, true, "tree"));
	pi.on("before_agent_start", (_event, ctx) => syncTools(ctx, false, "turn"));

	for (const name of ["config-palette", "resources"]) {
		pi.registerCommand(name, {
			description: "Toggle skills, extensions, tools, and MCP servers",
			handler: async (args, ctx) => {
				const standalone = pi.getFlag("config-palette-standalone") === true;
				try {
					await openPalette(args, ctx, tools, standalone);
				} finally {
					if (standalone) ctx.shutdown();
				}
			},
		});
	}
}
