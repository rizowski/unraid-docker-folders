# Quick Start - Resuming Development

**Last Session**: 2026-02-14
**Current Version**: v2026.02.14-11
**Status**: Blocked on page rendering issue

---

## TL;DR - Where We're At

✅ **What's Done**: Phase 1 complete, Phase 2 code complete
❌ **Blocker**: `.page` files don't render (blank pages)
💡 **Theory**: Unraid doesn't support `Menu="Docker"` sub-routes
🎯 **Next**: Test top-level menu or find working example

---

## Current Blocker

**Problem**: `/Docker/Folders` shows blank page (only Unraid header/footer)

**Direct URL works**: `/plugins/unraid-docker-folders-modern/assets/index.html` ✅

**Suspect**: Using `Menu="Docker"` to add sub-menu under Docker doesn't work. Need top-level menu instead.

---

## Quick Test to Try

### Option 1: Top-Level Menu (Most Likely Fix)

Edit `src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/pages/Docker.page`:

```diff
-Menu="Docker"
-Title="Folders"
+Menu="DockerFolders"
+Title="Docker Folders"
 Icon="folder"
 Type="php"
```

Then build and test:
```bash
./build/build.sh --release
# Install on Unraid and check if menu appears
```

### Option 2: Research First

On Unraid system:
```bash
# Find working plugins' .page files
find /usr/local/emhttp/plugins -name "*.page" -type f

# Check what Menu values they use
grep "^Menu=" /usr/local/emhttp/plugins/*/*.page
```

Study a working example and copy its approach.

---

## File Structure

```
/Users/rizowski/git/personal/unraid-docker/
├── STATUS.md              ← Full project status, phases, architecture
├── CURRENT_ISSUE.md       ← Detailed analysis of current blocker
├── QUICK_START.md         ← This file
├── src/
│   ├── frontend/          ← Vue 3 app (working)
│   └── backend/.../pages/ ← .page files (broken)
├── build/build.sh         ← Run this to build
└── archive/               ← Built .txz packages
```

---

## Build & Release

```bash
# Development build
./build/build.sh

# Release build (auto-increments, tags, pushes)
./build/build.sh --release

# Creates: archive/unraid-docker-folders-modern-<version>.txz
# Updates: unraid-docker-folders-modern.plg (version & MD5)
# Creates: Git tag and pushes to GitHub
```

Then manually create GitHub release and upload .txz:
https://github.com/rizowski/unraid-docker-folders/releases

---

## What's Working

- ✅ Vue 3 frontend builds successfully
- ✅ Frontend works when accessed directly
- ✅ Backend API endpoints implemented
- ✅ Database schema and migrations work
- ✅ Build system fully automated
- ✅ PLG installer works
- ✅ Plugin installs without errors

---

## What's Not Working

- ❌ Menu integration (blank pages)
- ❌ Can't test Phase 2 features until this is fixed

---

## Documentation

- **STATUS.md**: Read this for complete overview
- **CURRENT_ISSUE.md**: Read this for detailed blocker analysis
- **QUICK_START.md**: This file (high-level summary)

---

## When This is Fixed

Once pages render, immediate tasks:

1. Test folder creation
2. Test drag-and-drop
3. Test container assignment
4. Test export/import
5. Complete Phase 2 checklist

Then move to Phase 3 (WebSocket real-time updates).

---

## Helpful Commands

```bash
# Build release
./build/build.sh --release

# Check current version in PLG
grep "<!ENTITY version" unraid-docker-folders-modern.plg

# View git tags
git tag -l

# Start frontend dev server (for testing Vue app in isolation)
cd src/frontend && npm run dev

# View built archives
ls -lh archive/
```

---

**Don't forget**: The frontend works perfectly when accessed directly. This is purely a menu integration issue. The actual application logic is complete and ready to test.
