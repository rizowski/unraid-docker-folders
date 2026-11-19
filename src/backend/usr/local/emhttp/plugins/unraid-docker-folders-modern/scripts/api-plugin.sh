#!/bin/bash
#
# Installs, removes and reports the GraphQL backend, the npm package that runs
# inside the Unraid API. The .plg, the settings page and the backend watchdog
# all go through this script, so there is one copy of the logic.
#
#   api-plugin.sh install [--activate]   install or refresh; --activate also
#                                         sets backend_mode to graphql, but
#                                         only after the backend answers
#   api-plugin.sh remove [--no-restart]   take it out of the API. With
#                                         --no-restart, for a backend the API
#                                         never loaded, the API keeps running.
#   api-plugin.sh rollback                set backend_mode to php, then remove.
#                                         The manual way back if the webgui
#                                         stops working.
#   api-plugin.sh status                  print the last state
#
# --run <id> (hex) tags the state file, so the settings page can tell its own
# run from a boot run or a watchdog run that shares the file.
#
# The API is optional and upstream gives no stable contract for its plugins,
# so a failure here is logged and recorded in the state file, never fatal to
# the PHP backend.

# Cron gives its jobs PATH=/bin:/sbin:/usr/bin:/usr/sbin, and unraid-api and
# node live under /usr/local.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH}"

# `unraid-api plugins install` runs npm install in the API's folder. npm's
# audit and funding notices there report on Unraid's own dependencies, and
# the audit contacts the npm registry, so both are off. npm reads these from
# the environment, whatever flags unraid-api passes it.
export npm_config_audit=false
export npm_config_fund=false

PLUGIN_NAME="unraid-docker-folders-modern"
PLUGIN_DIR="/usr/local/emhttp/plugins/${PLUGIN_NAME}"
CONFIG_DIR="/boot/config/plugins/${PLUGIN_NAME}"
LOG_FILE="${CONFIG_DIR}/install.log"
STATE_FILE="/var/run/${PLUGIN_NAME}.api-plugin.state"
LOCK_FILE="/var/run/${PLUGIN_NAME}.api-plugin.lock"
ROLLBACK_MARKER="${CONFIG_DIR}/backend-rollback.json"

API_PLUGIN_PKG="unraid-api-plugin-docker-folders"
API_CONFIG="/boot/config/plugins/dynamix.my.servers/configs/api.json"
API_DIR="/usr/local/unraid-api"
API_SOCKET="/var/run/unraid-api.sock"

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') api-plugin: $*" >> "${LOG_FILE}"
}

# Reasons are fixed strings from this script, or from api-version.php, whose
# only variable part is a version that dfmUnraidApiVersion() matched against
# a digits-and-dots pattern. RUN_ID is hex. None of them needs JSON escaping.
RUN_ID=""
write_state() {
  printf '{"state":"%s","reason":"%s","at":%s,"run":"%s"}\n' "$1" "$2" "$(date +%s)" "${RUN_ID}" > "${STATE_FILE}"
}

# `plugins install` writes the tarball path into api.json's plugins list, but
# the API matches that list against package names. Measured on API 4.35.1:
# with the path the plugin can go unlisted, with the name it lists and loads.
# add: replace any entry for the package with its bare name. remove: drop it.
api_config_plugin() {
  [ -f "${API_CONFIG}" ] || return 0
  node -e '
    const fs = require("fs");
    const [file, name, action] = process.argv.slice(1);
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    const before = config.plugins || [];
    const others = before.filter((p) => typeof p === "string" && !p.includes(name));
    const after = action === "add" ? [...others, name] : others;
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      config.plugins = after;
      fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
    }
  ' "${API_CONFIG}" "${API_PLUGIN_PKG}" "$1" >> "${LOG_FILE}" 2>&1 || true
}

# A positive match on the field itself: an unauthenticated answer names it in
# its error path, while a missing field and "Graphql is offline" do not.
probe_backend() {
  curl -s --max-time 5 --unix-socket "${API_SOCKET}" \
    -H 'Content-Type: application/json' \
    -d '{"query":"query { dockerFoldersInfo { version } }"}' \
    http://localhost/graphql 2>/dev/null \
    | grep -q '"path":\["dockerFoldersInfo"\]\|"dockerFoldersInfo":{'
}

# Every unraid-api call has a timeout. The watchdog removes the backend when
# the API is wedged, which is when these are most likely to hang, and a hang
# would hold the lock and leave the state at "removing".
api_online() {
  timeout 15 unraid-api status 2>/dev/null | grep -q 'online'
}

# Print "<version> <contentHash>" from a package.json file, or "-" for stdin.
package_id() {
  node -e '
    const fs = require("fs");
    try {
      const p = JSON.parse(fs.readFileSync(process.argv[1] === "-" ? 0 : process.argv[1], "utf8"));
      process.stdout.write((p.version || "") + " " + (p.contentHash || "") + "\n");
    } catch { process.stdout.write("\n"); }
  ' "$1" 2>/dev/null
}

backend_in_api() {
  [ -d "${API_DIR}/node_modules/${API_PLUGIN_PKG}" ]
}

# `unraid-api restart` does not reload a plugin; stop then start does.
# Waits up to 60 s for the given check to pass.
restart_api_until() {
  timeout 60 unraid-api stop >> "${LOG_FILE}" 2>&1 || true
  timeout 60 unraid-api start >> "${LOG_FILE}" 2>&1 || true
  local waited=0
  while [ "${waited}" -lt 60 ]; do
    sleep 3
    waited=$((waited + 3))
    "$@" && return 0
  done
  return 1
}

set_mode() {
  php "${PLUGIN_DIR}/scripts/set-backend-mode.php" "$1" >> "${LOG_FILE}" 2>&1
}

do_install() {
  local activate="$1"

  if ! command -v unraid-api >/dev/null 2>&1; then
    write_state failed "The Unraid API is not on this system. It ships with Unraid 7.2 and later."
    log "no unraid-api command"
    return 1
  fi

  # The backend runs inside the API, which gives plugins no stable contract,
  # so it installs only on API versions it is tested on (include/api-compat.json).
  local version_check
  if ! version_check=$(php "${PLUGIN_DIR}/scripts/api-version.php" 2>&1 </dev/null); then
    write_state failed "${version_check}"
    log "API version refused: ${version_check}"
    return 1
  fi

  local src
  src=$(ls "${PLUGIN_DIR}"/api-plugin/${API_PLUGIN_PKG}-*.tgz 2>/dev/null | head -1)
  if [ -z "${src}" ]; then
    write_state failed "This build does not include the GraphQL backend package."
    log "no bundled tarball"
    return 1
  fi

  write_state installing ""

  # The API records the tarball's path in its package.json. Only /boot survives
  # a reboot, and a relative path would resolve inside /usr/local/unraid-api.
  local tgz="${CONFIG_DIR}/api-plugin/$(basename "${src}")"

  # The install is skipped when the API already runs this code, because
  # `unraid-api plugins install` restarts the API, runs npm, and writes a
  # ~22 MB archive of the API's node_modules to the flash drive every time.
  # The API's package.json must also point at a tarball that is still on
  # /boot, or the backend would be gone after a reboot.
  #
  # Same code means the same contentHash, which build.sh computes over the
  # backend's files without its version. Each build has a new version, so a
  # plugin update that did not change the backend keeps the installed one.
  local want_version want_hash have_version have_hash linked
  # Set when this run replaced backend code the API may still have loaded.
  local replaced_backend=0
  read -r want_version want_hash < <(tar -xzOf "${src}" package/package.json 2>/dev/null | package_id -)
  read -r have_version have_hash < <(package_id "${API_DIR}/node_modules/${API_PLUGIN_PKG}/package.json")
  linked=$(grep -o "${API_PLUGIN_PKG}-[^\"/]*\.tgz" "${API_DIR}/package.json" 2>/dev/null | head -1)

  if [ -n "${want_hash}" ] && [ "${want_hash}" = "${have_hash}" ] \
    && [ -n "${linked}" ] && [ -f "${CONFIG_DIR}/api-plugin/${linked}" ]; then
    echo "GraphQL mode is on. Its backend in the Unraid API is up to date (${have_version})."
    log "backend ${have_version} has the same code as ${want_version}, skipping install"
  else
    if [ -n "${have_version}" ]; then
      replaced_backend=1
      echo "GraphQL mode is on. Updating its backend in the Unraid API to ${want_version}..."
    else
      echo "GraphQL mode is on. Installing its backend in the Unraid API..."
    fi
    mkdir -p "${CONFIG_DIR}/api-plugin"
    rm -f "${CONFIG_DIR}"/api-plugin/${API_PLUGIN_PKG}-*.tgz
    cp "${src}" "${CONFIG_DIR}/api-plugin/"
    if ! timeout 300 unraid-api plugins install "${tgz}" >> "${LOG_FILE}" 2>&1; then
      echo "  ! GraphQL backend install failed; the PHP backend is unaffected"
      write_state failed "unraid-api plugins install failed. See ${LOG_FILE}."
      log "WARNING: unraid-api plugins install failed"
      return 1
    fi
    # `plugins install` exits 0 when its npm step fails. Seen on API 4.37.5,
    # where npm refused a peer range with ERESOLVE and the install still
    # reported success. Read what npm actually put in node_modules.
    read -r have_version have_hash < <(package_id "${API_DIR}/node_modules/${API_PLUGIN_PKG}/package.json")
    if [ -z "${have_version}" ] || [ "${have_hash}" != "${want_hash}" ]; then
      echo "  ! GraphQL backend install failed; the PHP backend is unaffected"
      api_config_plugin remove
      write_state failed "npm did not install the GraphQL backend into the Unraid API. See ${LOG_FILE}."
      log "WARNING: unraid-api plugins install reported success, but node_modules has ${have_version:-nothing} (${have_hash:-no hash}), not ${want_version} (${want_hash})"
      return 1
    fi
    api_config_plugin add
  fi

  # Reload only when the API is already running. At boot the API may not be
  # up yet, and starting it from here would race Unraid's own start of it;
  # it loads the plugin by itself when it comes up.
  #
  # Two reasons to reload, one stop and start for both. The backend does not
  # answer yet (a first install). Or this run replaced backend code that was
  # already installed: the running API keeps serving the old code, and so
  # answers the probe, until it is stopped and started. Without this, a fix in
  # the backend would wait for the next reboot, and a new frontend could ask
  # for fields the old code lacks.
  if api_online; then
    if [ "${replaced_backend}" = "1" ]; then
      echo "  Reloading the Unraid API to load the updated GraphQL backend..."
      log "reloading the Unraid API to load the updated GraphQL backend (${want_version})"
      restart_api_until probe_backend
    elif ! probe_backend; then
      restart_api_until probe_backend
    fi
  fi

  if probe_backend; then
    echo "  ✓ GraphQL backend loaded"
    log "GraphQL backend loaded"
    # "ready" is written last: the settings page reads the mode once it sees it.
    if [ "${activate}" = "1" ]; then
      if ! set_mode graphql; then
        # The backend stays only while backend_mode is graphql.
        log "WARNING: could not set backend_mode to graphql; removing the backend"
        do_remove 1 0
        write_state failed "The backend installed, but backend_mode could not be saved, so it was removed again."
        return 1
      fi
      rm -f "${ROLLBACK_MARKER}"
      log "backend_mode set to graphql"
    fi
    write_state ready ""
    return 0
  fi

  if [ "${activate}" = "1" ]; then
    # A backend that does not answer can be the reason the whole GraphQL
    # service is down, so it does not stay in the API for a PHP-mode user.
    log "WARNING: GraphQL backend not answering after install; removing it, backend_mode left as is"
    do_remove 1 0
    write_state failed "The Unraid API did not load the GraphQL backend, so it was removed again. See /var/log/graphql-api.log."
    return 1
  fi
  if api_online; then
    echo "  ! GraphQL backend installed but not answering; the PHP backend is unaffected"
    write_state failed "The Unraid API did not load the GraphQL backend. See /var/log/graphql-api.log."
    log "WARNING: GraphQL backend not answering after install"
    return 1
  fi
  write_state installed "The Unraid API is not running yet. It loads the backend when it starts."
  log "installed; the API is not running yet"
  return 0
}

# do_remove [restart] [final]. restart=0 leaves the API running, for a
# backend it never loaded. final=0 leaves the terminal state to the caller,
# so the settings page does not take a nested removal for the end of an
# install.
do_remove() {
  local restart="${1:-1}" final="${2:-1}"
  if ! command -v unraid-api >/dev/null 2>&1; then
    [ "${final}" = "1" ] && write_state removed ""
    return 0
  fi

  write_state removing ""
  local was_installed=0
  backend_in_api && was_installed=1

  if [ "${was_installed}" = "1" ]; then
    echo "Removing the GraphQL backend..."
    # `plugins remove` restarts the API by default, and restart_api_until
    # below restarts it again. --no-restart leaves that to this script. An
    # API without the option fails the command, so it runs again without it.
    timeout 120 unraid-api plugins remove --no-restart "${API_PLUGIN_PKG}" >> "${LOG_FILE}" 2>&1 \
      || timeout 120 unraid-api plugins remove "${API_PLUGIN_PKG}" >> "${LOG_FILE}" 2>&1 || true
  fi
  api_config_plugin remove

  # Code the API already loaded stays loaded until the API restarts.
  if [ "${restart}" = "1" ] && [ "${was_installed}" = "1" ] && api_online; then
    restart_api_until api_online
  fi

  if backend_in_api; then
    [ "${final}" = "1" ] && write_state failed "unraid-api plugins remove did not remove the GraphQL backend. See ${LOG_FILE}."
    log "WARNING: GraphQL backend still present after remove"
    return 1
  fi
  [ "${final}" = "1" ] && write_state removed ""
  log "GraphQL backend removed"
  return 0
}

verb="$1"
shift
activate=0
restart=1
while [ $# -gt 0 ]; do
  case "$1" in
    --activate) activate=1 ;;
    --no-restart) restart=0 ;;
    --run)
      shift
      [[ "$1" =~ ^[0-9a-f]{1,32}$ ]] && RUN_ID="$1"
      ;;
  esac
  shift
done

case "${verb}" in
  status)
    cat "${STATE_FILE}" 2>/dev/null || echo '{"state":"unknown","reason":"","at":0}'
    exit 0
    ;;
  install|remove|rollback) ;;
  *)
    echo "usage: $0 install [--activate] | remove | rollback | status" >&2
    exit 2
    ;;
esac

mkdir -p "${CONFIG_DIR}"
exec 9> "${LOCK_FILE}"
if ! flock -w 600 9; then
  log "WARNING: another api-plugin.sh run held the lock for 10 minutes"
  [ -n "${RUN_ID}" ] && write_state failed "Another install or removal is still running. Try again later."
  exit 1
fi

case "${verb}" in
  install)
    do_install "${activate}"
    ;;
  remove)
    do_remove "${restart}"
    ;;
  rollback)
    echo "Setting the backend to PHP..."
    set_mode php || echo "  ! Could not write backend_mode; continuing with the removal"
    do_remove
    ;;
esac
