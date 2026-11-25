# pi-config-palette

Think `pi config`, but with more switches and without leaving your session.

Toggle skills, extensions, tools, and native MCP servers in one place.

Skills and extensions use their existing global/project scope and tools get global/session modes.

## Install

Requires Pi `1.5.2+`.

```sh
pi install npm:pi-config-palette
```

Then `/reload` in Pi and run `/config-palette`.

## How changes apply

**Toggles save immediately. Esc is not an undo button.**

When you close the palette inside Pi, Pi reloads automatically once it’s idle if you changed any skills, extensions, or MCP servers. Tool changes need no reload. Session tool choices beat Global ones and survive resume, but don't follow you into new sessions.

Tool toggles are preferences, **not security permissions**. Other extensions can change the active tools too.

For MCP servers, **ON** means enabled in config, not connected. Check connection status with `/mcp`.

## From your shell

```sh
pi-config-palette
```

Run from your project.

Tools are **cached, Global-only**. Refresh via `/config-palette` inside Pi in the same folder and trust state. Enabling a tool won’t enable its extension.

After making changes from the shell, run `/reload`.

## Keys

| Key                    | Does the thing                               |
| ---------------------- | -------------------------------------------- |
| `1` / `2` / `3` / `4`  | Skills / Extensions / Tools / MCP            |
| `←` / `→` - `h` / `l` | Switch tabs left / right                     |
| `↓` / `↑` - `j` / `k` | Move down / up in the list                   |
| `g` / `G`              | Jump to top / bottom                         |
| `Tab`                  | Switch scope                                 |
| `Space` / `Enter`      | Toggle                                       |
| `f`                    | Star / unstar                                |
| `/`                    | Fuzzy search                                 |
| `s`                    | Cycle ON-first / OFF-first / default sorting |
| `d`                    | Details                                      |
| `?`                    | Help, if this wasn't enough                  |
| `Esc`                  | Leave search, clear filter, then close       |

While editing a search, `←` and `→` move the text cursor. Press `Enter` / `Esc` to keep the filter and return to tab navigation.

## Related

Use `/config-palette` to enable/disable skills combined with `/skill` from [pi-skill-palette](https://github.com/nicobailon/pi-skill-palette) to queue skills for your next message or pin them.
