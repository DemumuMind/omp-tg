#!/bin/sh
set -eu

dest="${BACKUP_DIR:-/var/backups/omp-tg}"
user="${OMP_USER:-omp}"
session_root="${OMP_SESSION_ROOT:-/home/${user}/.omp/tg-sessions}"
env_file="${OMP_ENV_FILE:-/etc/omp-tg/env}"
keep_days="${BACKUP_KEEP_DAYS:-14}"

install -d -m 0700 "$dest"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="${dest}/omp-tg-${stamp}.tar.gz"

paths=""
[ -f "$env_file" ] && paths="$paths $env_file"
[ -d "$session_root" ] && paths="$paths $session_root"
if [ -z "$paths" ]; then
  echo "nothing to back up"
  exit 0
fi

# shellcheck disable=SC2086
tar -czf "$archive" -C / $paths
chmod 0600 "$archive"
find "$dest" -maxdepth 1 -name 'omp-tg-*.tar.gz' -type f -mtime "+${keep_days}" -delete
echo "backup written: $archive"
