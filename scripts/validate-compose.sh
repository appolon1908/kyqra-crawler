#!/usr/bin/env bash
set -euo pipefail

export KYQRA_IMAGE='ghcr.io/appolon1908-hue/kyqra-crawler@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
export KYQRA_ENV_FILE='test/fixtures.env'
export KYQRA_SERVICE_PRINCIPALS_FILE='test/fixtures-service-principals.json'
export KYQRA_REDIS_PASSWORD_FILE='/tmp/kyqra-ci-redis-password'
export KYQRA_POSTGRES_PASSWORD_FILE='/tmp/kyqra-ci-postgres-password'
export KYQRA_MIDDLEWARE_API_KEY_FILE='/tmp/kyqra-ci-middleware-api-key'
export KYQRA_WEBHOOK_SECRET_FILE='/tmp/kyqra-ci-webhook-secret'
export KYQRA_SECRETS_GID='65534'
docker compose -f docker-compose.yml config --quiet
rendered=$(docker compose -f docker-compose.yml config)
rendered_json=$(docker compose -f docker-compose.yml config --format json)
grep -Fq 'host_ip: 127.0.0.1' <<<"$rendered"
grep -Fq 'published: "3100"' <<<"$rendered"
! grep -Eq 'published: "?(5432|6379)' <<<"$rendered"
! grep -Eq 'host_ip: (0\.0\.0\.0|10\.40\.0\.4)' <<<"$rendered"
jq -e '
  . as $compose |
  (.services.migrate.command == ["node", "dist/storage/postgres/migrate.js", "up"]) and
  (.services.migrate.restart == "no") and
  ((.services.migrate.ports // []) | length == 0) and
  (.services.api.depends_on.migrate.condition == "service_completed_successfully") and
  (
    ["migrate", "api", "http-worker", "browser-worker", "callback-worker"] |
    map(. as $service | (($compose.services[$service].group_add // []) | map(tostring) | index("65534")) != null) |
    all
  )
' <<<"$rendered_json" >/dev/null
echo 'DOCKER_COMPOSE_VALIDATE=PASS'
