# Changelog

## 2026.02.23-6
### Changes
- Fix z-index, hover flicker, action spinner + add hide stopped toggle

## 2026.02.23-5
### Changes
- Fix drag-drop duplication, card padding, folder kebab menu, and z-index

## 2026.02.23-4
### Changes
- Pass Unraid CSS variables into iframe for dark theme support

## 2026.02.23-2
### Changes
- Load app in iframe to isolate from Unraid global CSS

## 2026.02.23
### Changes
- Add Markdown="false" to DockerFoldersMain.page to fix styles not loading

## 2026.02.15-42
### Changes
- Add container action feedback, image update checking, and pull with progress
- Add UI animations: folder collapse, modal transitions, state pulse, card fade-in

## 2026.02.15-41
### Changes
- Always show app on Folders tab regardless of replace setting

## 2026.02.15-40
### Changes
- Simplify inject page to only collapse native Docker section

## 2026.02.15-39
### Changes
- Wrap native Docker section in collapsed accordion instead of hiding

## 2026.02.15-38
### Changes
- remove changelog
- Fix Docker section replacement race condition with async rendering
- Include CHANGELOG.md in release commit

## 2026.02.15-37
### Changes
- Auto-generate CHANGELOG.md from git history during release builds
- Generate release notes from commits since last tag
- Update docs to reflect container search, live stats, and UI polish
- Make labels and volumes sections horizontally scrollable
- Add container search to filter by name or image
- Fix duplicate #app elements when replace_docker_section is enabled
- Stack health, command, and labels vertically in card view

## 2026.02.15-36
### Changes
- Add container details (command, health, labels) to expanded accordion
- Swap volume display order to source -> destination
- Add link icon next to image URLs and volume paths
- Redesign list view row layout
- Gray out folder count badge when no containers are running
- Fix folder associations lost when containers are recreated
- Make entire list row clickable to expand/collapse

## 2026.02.15-35
### Changes
- Fix stats, ports, image, and status hidden in iframe

## 2026.02.15-34
### Changes
- Hide drag handles when drag & drop is locked
- Update PLG changes section with latest changelog
- Move settings icon to far left of header

## 2026.02.15-33
### Changes
