# Current Work - Phase 3: Live Container Resource Stats

**Date**: 2026-02-15
**Status**: Planning / implementation

---

## Goal

Add live resource consumption stats to the container card accordion panel. When a user expands a container card, they see real-time resource usage alongside the existing port/mount/network details.

## Stats to Display

### Visual bars (progress bar + percentage)
- **CPU** — percentage of allocated CPU
- **Memory** — usage / limit with percentage bar

### Numeric values
- **Block I/O** — read / write bytes
- **Network I/O** — rx / tx bytes
- **PIDs** — number of processes in the container

### Additional info
- **Restart count** — from container inspect (flags crash-looping)
- **Container uptime** — parsed from container `status` field or computed from `created`
- **Image size** — size of the container's image layers
- **Log size** — size of the container's log file (can grow unbounded without rotation)

## Docker API Sources

### `/containers/{id}/stats?stream=0` (one-shot)
Returns a single stats snapshot. Key fields:
- `cpu_stats.cpu_usage.total_usage` / `system_cpu_usage` / `online_cpus` → CPU %
- `memory_stats.usage` / `memory_stats.limit` → Memory usage + limit
- `blkio_stats.io_service_bytes_recursive` → Block I/O read/write
- `networks.{iface}.rx_bytes` / `tx_bytes` → Network I/O
- `pids_stats.current` → PID count

### `/containers/{id}/json` (inspect)
- `RestartCount` → restart count
- `State.StartedAt` → precise uptime calculation
- `SizeRw` / `SizeRootFs` → container size (requires `?size=true`, expensive)

### `/images/{id}/json` (image inspect)
- `Size` → image size in bytes

### Log size
- Read from Docker's log file path: `/var/lib/docker/containers/{id}/{id}-json.log`
- Or use `docker system df -v` equivalent via API

## Implementation Plan

### Backend
1. New `api/stats.php` — accepts `?ids=id1,id2,...` query param, returns stats for requested containers
2. PHP loops through IDs, calls Docker stats endpoint for each running container
3. Also fetches restart count from inspect, image size, log file size
4. Returns consolidated response: `{ stats: { [containerId]: { cpu, memory, io, network, pids, restartCount, uptime, imageSize, logSize } } }`

### Frontend
1. New `stores/stats.ts` — Pinia store that polls `api/stats.php` for expanded containers
2. Only fetches stats for containers whose accordion is currently expanded (efficient)
3. Polls every 5 seconds while any container is expanded, stops when all collapsed
4. `ContainerCard.vue` — accordion details panel shows:
   - CPU: thin progress bar (green/yellow/red based on usage) + "23.4%"
   - Memory: thin progress bar + "1.2 GB / 4.0 GB (30%)"
   - Block I/O: "Read: 45.2 MB / Write: 12.1 MB"
   - Network: "RX: 234.5 MB / TX: 12.3 MB"
   - PIDs: "12 processes"
   - Restart count: "3 restarts" (highlighted if > 0)
   - Uptime: "3 days, 2 hours"
   - Image size: "234.5 MB"
   - Log size: "12.3 MB"

### Mock API
- `dev/mock-api.ts` — add `stats.php` handler returning randomized but realistic stats

## Performance Considerations

- Stats are only fetched for expanded containers (not all containers on every poll)
- One-shot stats (`stream=0`) returns immediately, no long-polling
- 5-second poll interval balances freshness vs load
- Backend batches multiple container IDs in one request to avoid N frontend requests
- Image size and log size are relatively static — could cache these longer
