#!/bin/bash
#
# Unraid Docker Folders - Build Script
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
PLUGIN_NAME="unraid-docker-folders-modern"

# Check for --release flag
if [ "$1" == "--release" ]; then
  BASE_VERSION=$(date +%Y.%m.%d)
  BUILD_TYPE="release"
else
  VERSION=$(date +%Y.%m.%d-%H%M)
  BUILD_TYPE="development"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="/tmp/${PLUGIN_NAME}-build"
ARCHIVE_DIR="${PROJECT_ROOT}/archive"
FRONTEND_DIR="${PROJECT_ROOT}/src/frontend"
BACKEND_DIR="${PROJECT_ROOT}/src/backend"

# For release builds, determine build number
if [ "$BUILD_TYPE" == "release" ]; then
  mkdir -p "$ARCHIVE_DIR"

  # Find existing archives for today's date
  EXISTING_ARCHIVES=$(ls -1 "${ARCHIVE_DIR}/${PLUGIN_NAME}-${BASE_VERSION}"*.txz 2>/dev/null || true)

  if [ -z "$EXISTING_ARCHIVES" ]; then
    # No existing archive for this date
    VERSION="${BASE_VERSION}"
    BUILD_NUMBER=1
  else
    # Find the highest build number
    MAX_BUILD=0

    for archive in $EXISTING_ARCHIVES; do
      # Extract filename without path and extension
      FILENAME=$(basename "$archive" .txz)

      # Check if it has a build number (format: YYYY.MM.DD-N)
      if [[ $FILENAME =~ ${PLUGIN_NAME}-${BASE_VERSION}-([0-9]+)$ ]]; then
        BUILD_NUM=${BASH_REMATCH[1]}
        if [ "$BUILD_NUM" -gt "$MAX_BUILD" ]; then
          MAX_BUILD=$BUILD_NUM
        fi
      elif [[ $FILENAME == "${PLUGIN_NAME}-${BASE_VERSION}" ]]; then
        # First build (no build number suffix)
        if [ "$MAX_BUILD" -lt 1 ]; then
          MAX_BUILD=1
        fi
      fi
    done

    # Increment build number
    BUILD_NUMBER=$((MAX_BUILD + 1))
    VERSION="${BASE_VERSION}-${BUILD_NUMBER}"
  fi
fi

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Building ${PLUGIN_NAME} v${VERSION}${NC}"
echo -e "${BLUE}  Build Type: ${BUILD_TYPE}${NC}"
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

# Copy CHANGELOG.md into plugin directory for settings page
if [ -f "${PROJECT_ROOT}/CHANGELOG.md" ]; then
    cp "${PROJECT_ROOT}/CHANGELOG.md" "${BUILD_DIR}/usr/local/emhttp/plugins/${PLUGIN_NAME}/"
fi

# Remove macOS metadata files
find "${BUILD_DIR}" -name "._*" -delete
find "${BUILD_DIR}" -name ".DS_Store" -delete

# Ensure proper permissions
find "${BUILD_DIR}" -type f -name "*.php" -exec chmod 644 {} \;
find "${BUILD_DIR}" -type f -name "*.page" -exec chmod 644 {} \;
find "${BUILD_DIR}" -type f -name "*.sh" -exec chmod 755 {} \;
find "${BUILD_DIR}" -type f -name "*.sql" -exec chmod 644 {} \;
find "${BUILD_DIR}" -type f -name "*.html" -exec chmod 644 {} \;
find "${BUILD_DIR}" -type f -name "*.js" -exec chmod 644 {} \;
find "${BUILD_DIR}" -type f -name "*.css" -exec chmod 644 {} \;
find "${BUILD_DIR}" -type d -exec chmod 755 {} \;

echo -e "${GREEN}✓${NC} Backend packaged"
echo ""

# Create .txz package
echo -e "${YELLOW}[4/5]${NC} Creating .txz archive..."
cd "$BUILD_DIR"

# Remove macOS resource forks and metadata files
find . -name "._*" -delete
find . -name ".DS_Store" -delete

ARCHIVE_PATH="${ARCHIVE_DIR}/${PLUGIN_NAME}-${VERSION}.txz"

# Create archive excluding macOS files and setting ownership to root
COPYFILE_DISABLE=1 tar --exclude='._*' --exclude='.DS_Store' --owner=root --group=root -cJf "$ARCHIVE_PATH" usr/

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
echo "Build Type: ${BUILD_TYPE}"
echo "Package: ${ARCHIVE_PATH}"
echo "Size: ${ARCHIVE_SIZE}"
echo "MD5: ${MD5}"
echo ""

if [ "$BUILD_TYPE" == "release" ]; then
  echo -e "${YELLOW}Release Build Complete${NC}"
  if [ -n "$BUILD_NUMBER" ]; then
    echo "Build Number: ${BUILD_NUMBER}"
  fi
  echo ""
  echo -e "${GREEN}✓ Fully Automated Release Process Complete!${NC}"
  echo ""
  echo "Package: ${PLUGIN_NAME}-${VERSION}.txz (${ARCHIVE_SIZE})"
  echo "MD5: ${MD5}"
  echo ""
  echo "Release available at:"
  echo "  https://github.com/rizowski/unraid-docker-folders/releases/tag/v${VERSION}"
  echo ""
  echo "Install on Unraid using:"
  echo "  https://raw.githubusercontent.com/rizowski/unraid-docker-folders/main/unraid-docker-folders-modern.plg"
  echo ""
  if [ "$BUILD_NUMBER" -gt 1 ]; then
    echo -e "${YELLOW}Note: This is build #${BUILD_NUMBER} for ${BASE_VERSION}${NC}"
    echo "Previous builds exist in the archive directory."
    echo ""
  fi
else
  echo -e "${YELLOW}Development Build${NC}"
  echo "For testing only - not for release"
  echo ""
  echo "To create a release build, run:"
  echo -e "  ${YELLOW}./build/build.sh --release${NC}"
fi
echo ""

# Clean up build directory
rm -rf "$BUILD_DIR"
echo -e "${GREEN}✓${NC} Cleaned up temporary files"
echo ""

# For release builds, update PLG file and create git tag
if [ "$BUILD_TYPE" == "release" ]; then
  echo -e "${BLUE}========================================${NC}"
  echo -e "${BLUE}  Update PLG & Git Workflow${NC}"
  echo -e "${BLUE}========================================${NC}"
  echo ""

  cd "$PROJECT_ROOT"

  # Check if we're in a git repository
  if ! git rev-parse --git-dir > /dev/null 2>&1; then
    echo -e "${YELLOW}⚠${NC} Not a git repository, skipping automatic updates"
  else
    PLG_FILE="${PROJECT_ROOT}/unraid-docker-folders-modern.plg"

    if [ ! -f "$PLG_FILE" ]; then
      echo -e "${RED}✗${NC} PLG file not found: $PLG_FILE"
      echo "Skipping automatic update"
    else
      # Update PLG file with new version and MD5
      echo "Updating PLG file with version ${VERSION} and MD5 ${MD5}..."

      # Use sed to update version and md5 entities
      if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS sed syntax
        sed -i '' "s/<!ENTITY version \"[^\"]*\">/<!ENTITY version \"${VERSION}\">/" "$PLG_FILE"
        sed -i '' "s/<!ENTITY md5 \"[^\"]*\">/<!ENTITY md5 \"${MD5}\">/" "$PLG_FILE"
      else
        # Linux sed syntax
        sed -i "s/<!ENTITY version \"[^\"]*\">/<!ENTITY version \"${VERSION}\">/" "$PLG_FILE"
        sed -i "s/<!ENTITY md5 \"[^\"]*\">/<!ENTITY md5 \"${MD5}\">/" "$PLG_FILE"
      fi

      if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓${NC} PLG file updated"

        # Check if there are changes to commit
        if git diff --quiet "$PLG_FILE"; then
          echo -e "${YELLOW}⚠${NC} No changes to PLG file (version/MD5 already up to date)"
        else
          # Stage and commit PLG file
          echo "Committing PLG file changes..."
          git add "$PLG_FILE"
          git commit -m "Update PLG for release ${VERSION}

- Version: ${VERSION}
- MD5: ${MD5}
- Package: ${PLUGIN_NAME}-${VERSION}.txz"

          if [ $? -eq 0 ]; then
            echo -e "${GREEN}✓${NC} PLG changes committed"

            # Push commits
            echo "Pushing commits to remote..."
            if git push origin "$(git branch --show-current)" 2>&1; then
              echo -e "${GREEN}✓${NC} Commits pushed to remote"
            else
              echo -e "${YELLOW}⚠${NC} Failed to push commits"
              echo "Run manually: git push origin main"
            fi
          else
            echo -e "${RED}✗${NC} Failed to commit PLG changes"
          fi
        fi
      else
        echo -e "${RED}✗${NC} Failed to update PLG file"
      fi
    fi

    echo ""

    # Create and push git tag
    TAG_NAME="v${VERSION}"
    TAG_EXISTS=0

    # Check if tag already exists
    if git rev-parse "$TAG_NAME" >/dev/null 2>&1; then
      echo -e "${YELLOW}⚠${NC} Tag ${TAG_NAME} already exists"
      echo "Skipping tag creation"
      TAG_EXISTS=1
    else
      # Create annotated tag
      echo "Creating tag: ${TAG_NAME}"
      RELEASE_NOTES="Release ${VERSION}

Phase 2: Folder Organization
- Full folder management with drag-and-drop
- Custom folder icons and colors
- Robust install/uninstall hooks
- Docker menu integration

Package: ${PLUGIN_NAME}-${VERSION}.txz
MD5: ${MD5}"

      git tag -a "$TAG_NAME" -m "$RELEASE_NOTES"

      if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓${NC} Tag created: ${TAG_NAME}"

        # Push tag to remote
        echo "Pushing tag to remote..."
        if git push origin "$TAG_NAME" 2>&1; then
          echo -e "${GREEN}✓${NC} Tag pushed to remote"
        else
          echo -e "${YELLOW}⚠${NC} Failed to push tag (you may need to push manually)"
          echo "Run: git push origin ${TAG_NAME}"
        fi
      else
        echo -e "${RED}✗${NC} Failed to create tag"
      fi
    fi

    echo ""

    # Create GitHub release and upload package
    if command -v gh &> /dev/null; then
      # Check if gh is authenticated
      if ! gh auth status >/dev/null 2>&1; then
        echo -e "${YELLOW}⚠${NC} GitHub CLI not authenticated"
        echo "Run 'gh auth login' to enable automatic release creation"
        echo ""
        echo "Or create release manually at:"
        echo "  https://github.com/rizowski/unraid-docker-folders/releases/new?tag=${TAG_NAME}"
      else
        echo "Creating GitHub release..."

        # Check if release already exists
        if gh release view "$TAG_NAME" >/dev/null 2>&1; then
        echo -e "${YELLOW}⚠${NC} Release ${TAG_NAME} already exists"

        # Ask if we should upload the asset anyway
        echo "Checking for existing assets..."
        ASSET_NAME="${PLUGIN_NAME}-${VERSION}.txz"

        if gh release view "$TAG_NAME" --json assets --jq ".assets[].name" | grep -q "^${ASSET_NAME}$"; then
          echo -e "${YELLOW}⚠${NC} Asset ${ASSET_NAME} already exists in release"
          echo "Skipping asset upload (delete the release to re-upload)"
        else
          echo "Uploading asset to existing release..."
          if gh release upload "$TAG_NAME" "${ARCHIVE_PATH}" 2>&1; then
            echo -e "${GREEN}✓${NC} Asset uploaded to release ${TAG_NAME}"
          else
            echo -e "${RED}✗${NC} Failed to upload asset"
          fi
        fi
      else
        # Create new release
        RELEASE_TITLE="Release ${VERSION}"
        RELEASE_BODY="## Phase 2: Folder Organization

### Features
- Full folder management with drag-and-drop
- Custom folder icons and colors
- Robust install/uninstall hooks
- Docker menu integration

### Installation
\`\`\`
https://raw.githubusercontent.com/rizowski/unraid-docker-folders/main/unraid-docker-folders-modern.plg
\`\`\`

### Package Details
- **Version:** ${VERSION}
- **Package:** ${PLUGIN_NAME}-${VERSION}.txz
- **MD5:** \`${MD5}\`
- **Size:** ${ARCHIVE_SIZE}"

        if gh release create "$TAG_NAME" \
          --title "$RELEASE_TITLE" \
          --notes "$RELEASE_BODY" \
          "${ARCHIVE_PATH}"; then
          echo -e "${GREEN}✓${NC} GitHub release created: ${TAG_NAME}"
          echo -e "${GREEN}✓${NC} Package uploaded to release"
        else
          echo -e "${RED}✗${NC} Failed to create GitHub release"
          echo "You can create it manually at:"
          echo "  https://github.com/rizowski/unraid-docker-folders/releases/new?tag=${TAG_NAME}"
        fi
      fi
      fi
    else
      echo -e "${YELLOW}⚠${NC} GitHub CLI (gh) not installed"
      echo "Install it to enable automatic release creation:"
      echo "  https://cli.github.com/"
      echo ""
      echo "Or create release manually at:"
      echo "  https://github.com/rizowski/unraid-docker-folders/releases/new?tag=${TAG_NAME}"
    fi
  fi

  echo ""
fi
