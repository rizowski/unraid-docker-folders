# Current Issue - CSRF Token Fix Applied

**Date**: 2026-02-15
**Status**: Fix applied, pending on-device testing

---

## Issue

POST/PUT/DELETE requests to the API returned empty responses, causing:
```
Error: Failed to execute 'json' on 'Response': Unexpected end of JSON input
```

Unraid syslog showed:
```
error: /plugins/unraid-docker-folders-modern/api/folders.php - missing csrf_token
```

## Root Cause

Unraid's webGUI (emhttpd) requires a `csrf_token` parameter on all state-changing HTTP requests. Without it, the request is rejected at the web server level with an empty response body - before PHP even runs.

The frontend runs inside an iframe, so it has no access to the parent page's CSRF token unless explicitly passed.

## Fix Applied

1. **`DockerFoldersMain.page`** - Reads CSRF token from PHP session, passes to iframe via query parameter:
   ```php
   $csrfToken = getCsrfToken();
   // ...
   <iframe src="...index.html?csrf_token=<?= urlencode($csrfToken) ?>">
   ```

2. **`src/frontend/src/utils/csrf.ts`** - New utility that reads the token from `window.location.search` and provides `withCsrf(url)` to append it to any URL.

3. **`stores/docker.ts`** and **`stores/folders.ts`** - All POST/PUT/DELETE fetch calls wrapped with `withCsrf()`.

## Previous Issues (Resolved)

- **Page rendering blank**: `Docker.page` filename collided with Unraid's built-in page. Renamed to `DockerFoldersMain.page`.
- **PDOException catch**: `FolderManager.php` line 178 caught `PDOException` but codebase uses SQLite3 native. Changed to `Exception`.

## Verification Steps

1. Build and install: `./build/build.sh --release`
2. Open Docker > Folders tab
3. Click "+ Create Folder" - should create successfully (no more empty response error)
4. Check Unraid syslog - should have no `missing csrf_token` errors
5. Test all mutation operations: create/edit/delete folder, start/stop/restart/remove container
