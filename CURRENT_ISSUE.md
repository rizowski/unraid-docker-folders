# Current Work - UI Polish & Improvements

**Date**: 2026-02-15
**Status**: Ongoing

---

## Recently Completed

### Container Search
- Search input in App.vue header filters containers by name or image (case-insensitive substring)
- Folders with no matching containers are hidden during search
- Folders with matches auto-expand to show results
- Drag-and-drop is disabled while a search query is active
- Clear (X) button resets search and restores normal view
- Search state lives in `docker.ts` store as `searchQuery` ref

### Horizontally Scrollable Labels & Volumes
- Labels and volumes sections in ContainerCard use `overflow-x-auto` on the section container
- Individual lines use `whitespace-nowrap` so long values scroll instead of being truncated with ellipsis
- Applied to all 6 instances across grid view, list view, running, and not-running states

---

## Next Steps

1. **On-device testing**: Install on Unraid and verify all features end-to-end
2. **Phase 4: UI/UX Polish** — dark/light theme, responsive design, animations, loading skeletons
3. **Phase 5: Testing & Release** — unit tests, integration tests, documentation, v1.0 release
