# Current Issue - Page Rendering RESOLVED

**Date**: 2026-02-15
**Previous Status**: BLOCKED
**Current Status**: FIX APPLIED - Awaiting rebuild and test

---

## Root Cause Found

**The `.page` file was named `Docker.page`, which collides with Unraid's built-in `Docker.page`.**

Unraid's `PageBuilder.php` indexes pages by filename (without `.page` extension) in a `$site` array. Our `Docker.page` was overwriting the built-in Docker xmenu page, which:
1. Broke the entire Docker menu (our page had `Type="php"` instead of `Type="xmenu"`)
2. Prevented any sub-pages from rendering under Docker since the xmenu parent was replaced

Additionally, several header attributes were wrong:
- `Icon="folder"` should be `Tag="folder"` for tab pages (Icon is for Settings panels)
- Missing `Cond=` attribute (should only show when Docker is running)
- Missing `Markdown="false"` attribute
- No rank number in `Menu="Docker"` (should be `Menu="Docker:3"`)

## Fix Applied

### DockerFolders.page (renamed from Docker.page)
```
Menu="Docker:3"
Title="Folders"
Tag="folder"
Cond="is_file('/var/run/dockerd.pid')"
Markdown="false"
```

This will appear as a "Folders" tab in the Docker menu, after the existing Docker tabs.

### Settings.page
```
Menu="OtherSettings"
Title="Docker Folders Modern"
Icon="folder"
Tag="folder"
Markdown="false"
```

Changed from `Menu="Utilities"` to `Menu="OtherSettings"` and added `Tag` attribute.

## Key Learnings About Unraid .page Files

### How Unraid Parses .page Files
- `PageBuilder.php` uses `parse_ini_string()` on the header section
- Pages are indexed by filename: `Docker.page` -> `$site['Docker']`
- **NEVER use a filename that matches a built-in page** (Docker, VMs, Main, Settings, etc.)

### Valid Attributes
| Attribute | Purpose | Used By |
|-----------|---------|---------|
| `Menu` | Menu location (supports `Menu:rank` for ordering) | All pages |
| `Title` | Display title | All pages |
| `Type` | `xmenu` = top-level nav, `menu` = dropdown, `php` = content page | All pages |
| `Tag` | FontAwesome icon for tabs/sub-pages | Sub-pages |
| `Icon` | Icon for Settings panel pages | Settings pages |
| `Code` | Unicode code point for sidebar icon (hex) | xmenu pages |
| `Cond` | Conditional display expression | Optional |
| `Markdown` | Enable/disable markdown processing | Optional |
| `Tabs` | Enable tabbed interface | Optional |

### Valid Menu Values
- `Tasks` - Top-level header bar (used by Docker, VMs, etc.)
- `Docker` - Sub-pages under Docker (as tabs)
- `VMs` - Sub-pages under VMs
- `Settings` - Settings menu
- `OtherSettings` - Settings sub-category
- `Utilities` - Utilities menu
- `UserPreferences` - User preference pages

## Next Steps

1. Run `./build/build.sh --release` to build new package
2. Create GitHub release, upload .txz
3. Install on Unraid
4. Verify "Folders" tab appears under Docker menu
5. Verify Settings page renders under Settings > Other Settings
6. If working, proceed to Phase 2 testing

## Previous Investigation (Archived)

See git history for the previous CURRENT_ISSUE.md content documenting the investigation process.
