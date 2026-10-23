#!/bin/sh
set -eu

repo="${OMP_TG_REPO:-DemumuMind/omp-tg}"
target="${OMP_TG_BIN:-/opt/omp-tg/bin/omp-tg}"
service="${OMP_TG_SERVICE:-omp-tg}"
base="https://github.com/${repo}/releases/latest/download"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL "${base}/omp-tg" -o "${tmp}/omp-tg"
curl -fsSL "${base}/omp-tg.sha256" -o "${tmp}/omp-tg.sha256"
(
  cd "$tmp"
  sha256sum -c omp-tg.sha256
)
chmod 0755 "${tmp}/omp-tg"

if [ -f "$target" ] && cmp -s "${tmp}/omp-tg" "$target"; then
  echo "omp-tg is already up to date"
  exit 0
fi

install -d -m 0755 "$(dirname "$target")"
if [ -f "$target" ]; then
  cp -f "$target" "${target}.prev"
fi
install -m 0755 "${tmp}/omp-tg" "${target}.new"
mv -f "${target}.new" "$target"
systemctl restart "$service"
echo "updated omp-tg from ${repo} at $(date -u +%FT%TZ)"
