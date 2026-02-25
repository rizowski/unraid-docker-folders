#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

docker build -t unraid-php-tests "$SCRIPT_DIR"
docker run --rm -v "$PROJECT_ROOT":/app unraid-php-tests phpunit --configuration tests/php/phpunit.xml
