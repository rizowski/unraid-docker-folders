#!/bin/bash
#
# Unraid Docker Modern - Build Script
#
# Builds the frontend and packages the plugin into a .txz archive
#

set -e  # Exit on error

# Colors for output
GREEN='\033[0.32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
PLUGIN_NAME="unraid-docker-modern"
VERSION=$(date +%Y.%m.%d)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="/tmp/${PLUGIN_NAME}-build"
ARCHIVE_DIR="${PROJECT_ROOT}/archive"
FRONTEND_DIR="${PROJECT_ROOT}/src/frontend"
BACKEND_DIR="${PROJECT_ROOT}/src/backend"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Building ${PLUGIN_NAME} v${VERSION}${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Clean previous build
echo -e "${YELLOW}[1/5]${NC} Cleaning previous build..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
mkdir -p "$ARCHIVE_DIR"
echo -e "${GREEN}✓${NC} Build directory prepared"
echo ""

# Build frontend
echo -e "${YELLOW}[2/5]${NC} Building frontend..."
cd "$FRONTEND_DIR"

if [ ! -d "node_modules" ]; then
    echo "Installing frontend dependencies..."
    npm ci --quiet
fi

echo "Running Vite build..."
npm run build --quiet

if [ ! -d "../backend/usr/local/emhttp/plugins/${PLUGIN_NAME}/assets" ]; then
    echo -e "${RED}✗${NC} Frontend build failed - assets directory not found"
    exit 1
fi

echo -e "${GREEN}✓${NC} Frontend built successfully"
echo ""

# Copy backend files to build directory
echo -e "${YELLOW}[3/5]${NC} Packaging backend..."
cd "$PROJECT_ROOT"

# Copy the entire backend structure
cp -r "${BACKEND_DIR}/usr" "${BUILD_DIR}/"

# Ensure proper permissions
find "${BUILD_DIR}" -type f -name "*.php" -exec chmod 644 {} \;
find "${BUILD_DIR}" -type f -name "*.sh" -exec chmod 755 {} \;
find "${BUILD_DIR}" -type d -exec chmod 755 {} \;

echo -e "${GREEN}✓${NC} Backend packaged"
echo ""

# Create .txz package
echo -e "${YELLOW}[4/5]${NC} Creating .txz archive..."
cd "$BUILD_DIR"

ARCHIVE_PATH="${ARCHIVE_DIR}/${PLUGIN_NAME}-${VERSION}.txz"
tar -cJf "$ARCHIVE_PATH" usr/

if [ ! -f "$ARCHIVE_PATH" ]; then
    echo -e "${RED}✗${NC} Failed to create archive"
    exit 1
fi

ARCHIVE_SIZE=$(du -h "$ARCHIVE_PATH" | cut -f1)
echo -e "${GREEN}✓${NC} Archive created: ${ARCHIVE_PATH} (${ARCHIVE_SIZE})"
echo ""

# Calculate MD5 checksum
echo -e "${YELLOW}[5/5]${NC} Calculating MD5 checksum..."
cd "$ARCHIVE_DIR"

if command -v md5sum &> /dev/null; then
    MD5=$(md5sum "${PLUGIN_NAME}-${VERSION}.txz" | awk '{print $1}')
elif command -v md5 &> /dev/null; then
    MD5=$(md5 -q "${PLUGIN_NAME}-${VERSION}.txz")
else
    echo -e "${RED}✗${NC} md5sum or md5 command not found"
    exit 1
fi

echo -e "${GREEN}✓${NC} MD5: ${MD5}"
echo ""

# Summary
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}Build complete!${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "Package: ${ARCHIVE_PATH}"
echo "Size: ${ARCHIVE_SIZE}"
echo "MD5: ${MD5}"
echo ""
echo "Update the PLG file with:"
echo -e "  ${YELLOW}<!ENTITY version \"${VERSION}\">${NC}"
echo -e "  ${YELLOW}<!ENTITY md5 \"${MD5}\">${NC}"
echo ""

# Clean up build directory
rm -rf "$BUILD_DIR"
echo -e "${GREEN}✓${NC} Cleaned up temporary files"
