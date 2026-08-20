#!/bin/sh
set -eu

: "${PORT:=3000}"
: "${API_DOMAIN:?API_DOMAIN is required}"
: "${API_PORT:?API_PORT is required}"
: "${WEB_DOMAIN:?WEB_DOMAIN is required}"
: "${WEB_PORT:?WEB_PORT is required}"
export PORT API_DOMAIN API_PORT WEB_DOMAIN WEB_PORT

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
