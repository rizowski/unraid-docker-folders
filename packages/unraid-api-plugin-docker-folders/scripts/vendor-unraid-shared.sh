#!/usr/bin/env bash
# Put @unraid/shared in vendor/, where package.json's devDependency points.
#
# Why this exists: @unraid/shared is not published to npm. On an Unraid box it
# is vendored into the API's own node_modules, so the plugin resolves it at
# runtime as a peer dependency and ships none of it. Type-checking and the
# test suite still need it, so something has to put a copy here.
#
# Two ways to get it:
#
#   release (default)  Take the prebuilt tarball out of the Unraid API's own
#                      release archive. This is the exact package the server
#                      runs, and it needs only curl and xz, which is what CI
#                      has. Checked against v4.35.1: its dist/ is identical to
#                      a build from source at the same version.
#   source             Clone unraid/api and build the package with pnpm. For
#                      working against an API version that has no release yet.
#
#   UNRAID_API_TAG=v4.35.1 scripts/vendor-unraid-shared.sh [release|source]
#
# Keep the tag at the API version on the oldest server the plugin supports,
# and keep the tarball name in package.json in step with what it produces.
set -euo pipefail

MODE="${1:-release}"
UNRAID_API_TAG="${UNRAID_API_TAG:-v4.35.1}"
PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="${PKG_DIR}/vendor"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

mkdir -p "${VENDOR_DIR}"

if [ "${MODE}" = "release" ]; then
    VERSION="${UNRAID_API_TAG#v}"
    ASSET="dynamix.unraid.net-${VERSION}-x86_64-1.txz"
    URL="https://github.com/unraid/api/releases/download/${UNRAID_API_TAG}/${ASSET}"

    echo "==> Downloading ${ASSET}"
    curl -fsSL --retry 3 -o "${WORK_DIR}/${ASSET}" "${URL}"

    MEMBER="$(tar -tJf "${WORK_DIR}/${ASSET}" | grep -E '^usr/local/unraid-api/packages/unraid-shared-[^/]+\.tgz$' | head -1)"
    if [ -z "${MEMBER}" ]; then
        echo "No unraid-shared tarball inside ${ASSET}. Try: $0 source" >&2
        exit 1
    fi

    tar -xJf "${WORK_DIR}/${ASSET}" -C "${WORK_DIR}" "${MEMBER}"
    rm -f "${VENDOR_DIR}"/unraid-shared-*.tgz
    cp "${WORK_DIR}/${MEMBER}" "${VENDOR_DIR}/"
    echo "==> Wrote ${VENDOR_DIR}/$(basename "${MEMBER}")"
    exit 0
fi

if [ "${MODE}" != "source" ]; then
    echo "Unknown mode '${MODE}'. Use 'release' or 'source'." >&2
    exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
    echo "pnpm is required to build @unraid/shared. Run 'proto use' in the repo root." >&2
    exit 1
fi

CLONE_DIR="${WORK_DIR}/api"
echo "==> Cloning unraid/api at ${UNRAID_API_TAG}"
git clone --depth 1 --branch "${UNRAID_API_TAG}" https://github.com/unraid/api.git "${CLONE_DIR}"

echo "==> Installing dependencies for @unraid/shared"
cd "${CLONE_DIR}"
pnpm install --filter "@unraid/shared..." --ignore-scripts --frozen-lockfile=false

echo "==> Building @unraid/shared"
pnpm --filter "@unraid/shared" build

echo "==> Packing"
cd "${CLONE_DIR}/packages/unraid-shared"
rm -f "${VENDOR_DIR}"/unraid-shared-*.tgz
npm pack --pack-destination "${VENDOR_DIR}"
echo "==> Wrote $(ls "${VENDOR_DIR}"/unraid-shared-*.tgz | head -1)"
