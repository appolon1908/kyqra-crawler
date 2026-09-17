#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ $# -eq 4 ]] || { echo 'usage: build-release.sh MERGED_COMMIT IMAGE CLIENT_SERIAL OUTPUT_DIR' >&2; exit 64; }
commit=$1 image=$2 serial=$3 output=$4
[[ "$commit" =~ ^[0-9a-f]{40}$ ]]
[[ "$image" =~ ^ghcr\.io/appolon1908-hue/kyqra-crawler-production@sha256:[0-9a-f]{64}$ ]]
[[ "$serial" =~ ^[0-9A-F]+$ ]]
[[ ! -e "$output" ]]
install -d -m 0700 "$output"
install -m 0600 docker-compose.yml "$output/docker-compose.yml"
install -m 0600 config/nginx/kyqra-public.conf "$output/kyqra-public.conf"
sed "s/__KYQRA_CLIENT_SERIAL__/$serial/g" config/nginx/kyqra-private-mtls.conf.template >"$output/codestra-kyqra-mtls.conf"
sed -e "s/__MERGED_COMMIT__/$commit/g" -e "s#__PINNED_IMAGE__#$image#g" -e "s/__CLIENT_SERIAL__/$serial/g" release/templates/RELEASE.env >"$output/RELEASE.env"
sed "s#__RELEASE_DIR__#$output#g" release/templates/nginx-test.conf >"$output/nginx-test.conf"
tar -C src -czf "$output/src.tgz" .
docker image inspect "$image" >/dev/null
docker save "$image" -o "$output/kyqra-image.tar"
chmod 0600 "$output"/*
(cd "$output" && sha256sum RELEASE.env codestra-kyqra-mtls.conf docker-compose.yml kyqra-image.tar kyqra-public.conf nginx-test.conf src.tgz >SHA256SUMS)
echo "RELEASE_DIRECTORY=$output"
