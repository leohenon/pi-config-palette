import * as path from "node:path";
import type { ToolExposure } from "@earendil-works/pi-coding-agent";
import type { ResourceItem } from "./resources.ts";

export type ToolSaveMode = "saved" | "session";

export interface ToolItem {
  id: string;
  kind: "tool";
  name: string;
  description: string;
  source: string;
  sourcePath?: string;
  exposure: ToolExposure;
  inventory: "live" | "cached";
  capturedAt?: string;
  savedPreference?: boolean;
  sessionPreference?: boolean;
  savedEnabled?: boolean;
  sessionEnabled?: boolean;
  enabled: boolean;
  desired: boolean;
  mutable: boolean;
}

export interface McpItem {
  id: string;
  kind: "mcp";
  name: string;
  description: string;
  source: string;
  scope: "user" | "project";
  isOverride: boolean;
  enabled: boolean;
  desired: boolean;
  mutable: true;
}

export type PaletteItem = ResourceItem | ToolItem | McpItem;

export function favoriteKey(item: PaletteItem): string {
  return item.kind === "mcp"
    ? JSON.stringify([item.kind, item.source, item.name])
    : item.id;
}

export function extensionFileName(file: string): string {
  const { base, dir, name } = path.parse(file);
  return /^index\.(ts|js)$/.test(base) ? path.basename(dir) : name;
}

export function toolExtensionName(
  tool: ToolItem,
  extensions: ReadonlyMap<string, string>,
): string | undefined {
  const { source, sourcePath } = tool;
  if (source === "sdk") return undefined;
  const match = sourcePath && extensions.get(sourcePath);
  if (match) return match;
  if (source === "builtin") {
    // Core tools use their own name; codemode is a same-named extension.
    return sourcePath?.startsWith("builtin:") &&
      (sourcePath !== `builtin:${tool.name}` ||
        sourcePath === "builtin:codemode")
      ? sourcePath
      : undefined;
  }
  if (source === "inline")
    return sourcePath?.startsWith("<inline:") ? sourcePath : undefined;
  const npmName = /^npm:((?:@[\w.-]+\/)?[\w.-]+)(?:@.*)?$/.exec(source)?.[1];
  return (
    npmName ??
    (sourcePath && path.isAbsolute(sourcePath)
      ? extensionFileName(sourcePath)
      : undefined)
  );
}
