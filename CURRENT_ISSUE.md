# Current Issue - Page Rendering Blocked

**Date**: 2026-02-14
**Version**: v2026.02.14-11

---

## The Problem

Unraid .page files are not rendering any content - pages show completely blank (only Unraid header/footer framework).

### What We Tried
- ✅ Added `Type="php"` attribute to .page headers
- ✅ Changed icons to FontAwesome names (`Icon="folder"`)
- ✅ Removed full HTML document structure (no `<!DOCTYPE>`, `<html>`, etc.)
- ✅ Added PHP diagnostic output with HTML comments
- ✅ Simplified to basic content
- ❌ Still blank pages

### Current .page Configuration

**File**: `src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/pages/Docker.page`

```
Menu="Docker"
Title="Folders"
Icon="folder"
Type="php"
---
<?php
require_once '/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';
// PHP code...
?>
<style>...</style>
<div>
  <!-- Content with diagnostic info -->
  <iframe src="/plugins/unraid-docker-folders-modern/assets/index.html"></iframe>
</div>
```

### URLs
- ✅ **Works**: `/plugins/unraid-docker-folders-modern/assets/index.html` (direct asset)
- ❌ **Blank**: `/Docker/Folders` (page route)
- ❌ **Blank**: `/Settings/Utilities/DockerFoldersModern` (settings page)

---

## Key Discovery

**User Observation**: "I don't see that in any of my plugins. I do however have a plugin that added a top-level nav link."

This suggests **Unraid may not support sub-routes under core menus like "Docker"**.

Other plugins likely use:
- Top-level menu items (e.g., `Menu="MyPlugin"`)
- NOT sub-items under existing menus (e.g., `Menu="Docker"`)

---

## Hypothesis

The `Menu="Docker"` attribute may not work as expected. Unraid might:
1. Not support adding pages under core menus (Docker, VMs, etc.)
2. Require specific naming conventions or permissions
3. Only support top-level custom menus

---

## Next Steps to Investigate

### 1. Research Working Examples
```bash
# On Unraid system, find other plugins' .page files
find /usr/local/emhttp/plugins -name "*.page" -type f | head -20

# Check their Menu attributes
grep -h "^Menu=" /usr/local/emhttp/plugins/*/*.page | sort -u
```

### 2. Test Top-Level Menu
Try changing Docker.page to use a custom top-level menu:

```
Menu="DockerFolders"
Title="Docker Folders"
Icon="folder"
Type="php"
```

OR try Main menu:
```
Menu="Main"
Title="Docker Folders"
Icon="folder"
Type="php"
```

### 3. Check Unraid Documentation
- Plugin development docs
- .page file format specs
- Valid Menu attribute values
- Community Applications plugin guidelines

### 4. Examine Working Plugin
Find a plugin that successfully adds a menu item and study its approach:
- How is the .page file structured?
- What Menu value does it use?
- Any special configuration needed?

---

## Quick Test Plan

### Option A: Top-Level Menu
1. Edit `src/backend/.../pages/Docker.page`
2. Change `Menu="Docker"` to `Menu="DockerFolders"`
3. Change `Title="Folders"` to `Title="Docker Folders"`
4. Build: `./build/build.sh --release`
5. Install on Unraid
6. Check if menu item appears at top level
7. Check if page renders

### Option B: Main Menu Item
1. Change `Menu="Docker"` to `Menu="Main"`
2. Keep `Title="Docker Folders"`
3. Build and test

### Option C: Study Existing Plugin
1. On Unraid, find a working plugin with menu item
2. Read its .page file
3. Copy its approach exactly
4. Adapt for our use case

---

## If Pages Still Don't Render

Check these potential issues:

1. **File Permissions**
   ```bash
   # On Unraid
   ls -la /usr/local/emhttp/plugins/unraid-docker-folders-modern/pages/
   # Should be 644 for .page files
   ```

2. **PHP Errors**
   ```bash
   # Check Unraid PHP error log
   tail -f /var/log/nginx/error.log
   ```

3. **require_once Path**
   - Maybe config.php doesn't exist or has errors?
   - Try removing PHP code entirely, just use static HTML

4. **Unraid Cache**
   - Restart webGUI: `/etc/rc.d/rc.nginx restart`
   - Clear browser cache

---

## Workaround (If Needed)

If we can't get menu integration working, alternative approaches:

### Option 1: Standalone Page
- Don't use .page files
- Create a simple link/bookmark to:
  `/plugins/unraid-docker-folders-modern/assets/index.html`

### Option 2: Override Docker Tab
- Replace the entire Docker page (not just add to it)
- May conflict with core functionality

### Option 3: Custom Tab Script
- Use JavaScript to inject a tab into existing Docker page
- More complex, but might work

---

## Current Build Info

**Version**: v2026.02.14-11
**MD5**: 501397d6fb4dacbf76e6dfbdbe13824e
**Package**: `archive/unraid-docker-folders-modern-2026.02.14-11.txz`
**PLG URL**: https://raw.githubusercontent.com/rizowski/unraid-docker-folders/main/unraid-docker-folders-modern.plg

---

## When You Resume

1. Read STATUS.md for full project overview
2. Research how other Unraid plugins add menu items
3. Test top-level menu approach
4. Document findings
5. Once pages render, proceed with Phase 2 testing

**Remember**: The code is built and ready. We just need to solve the menu integration issue.
