#!/bin/sh
set -eu

password_file=/run/secrets/kyqra_redis_password
test -f "$password_file"
password=$(cat "$password_file")
case "$password" in
  *[!A-Za-z0-9_-]*|'')
    echo 'Redis password must be a URL-safe token' >&2
    exit 1
    ;;
esac
test "${#password}" -ge 32
test "${#password}" -le 200

umask 077
acl_file=/tmp/kyqra-redis.acl
printf 'user default on >%s ~* &* +@all\n' "$password" > "$acl_file"
unset password

exec redis-server \
  --appendonly yes \
  --appendfsync everysec \
  --maxmemory 2gb \
  --maxmemory-policy noeviction \
  --protected-mode yes \
  --aclfile "$acl_file"
