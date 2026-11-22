FROM php:8.3-cli-alpine

# bash for ApiPluginScriptTest: scripts/api-plugin.sh is a bash script.
RUN apk add --no-cache bash

RUN curl -sSL https://phar.phpunit.de/phpunit-11.phar -o /usr/local/bin/phpunit \
    && chmod +x /usr/local/bin/phpunit

WORKDIR /app
