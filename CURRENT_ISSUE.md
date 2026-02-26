# Current Work

**Date**: 2026-02-25
**Status**: Active development on `dev` branch

---

## Recently Completed

### Dev/Stable Release Channels
- Build script auto-detects branch (`dev` vs `main`) for release channel
- Dev builds: `YYYY.MM.DD-devN` versioning, GitHub pre-releases, PLG points to `dev` branch
- Stable builds: unchanged `YYYY.MM.DD` format on `main`
- `./build/build.sh --release` works on either branch

### Concurrent Container Action Loading
- Fixed bug where clicking start/stop/restart on multiple containers only showed spinner on last one
- Changed `actionInProgress` from single ref to `Map<string, string>` in App.vue and FolderContainer.vue
- Each container tracks its own loading state independently

### Component Extraction & Refactoring
- Extracted `ChevronIcon`, `DragHandle`, `ImageLink`, `StatsBar` into `components/common/`
- Added `useContainerStats` composable for visibility-based stats polling
- Fixed StatsBar inline variant using `w-16` fixed width (was `flex-1` causing collapsed bars in folder headers)

### Tests
- StatsBar: 20 tests covering loading skeletons, color thresholds, bar widths, size variants
- ContainerCard: 6 tests for action loading state display
- FolderContainer: 1 test for concurrent multi-container loading
- DockerClientStatsTest: PHP tests for stats parsing

---

## Next Steps

1. **On-device testing**: Install dev build on Unraid, verify all features
2. **Promote to stable**: `git checkout main && git merge dev && ./build/build.sh --release`
