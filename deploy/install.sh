#!/bin/sh
set -eu
src="${1:-dist/omp-tg}"
target="/opt/omp-tg/bin"
install -d -m 0755 "$target"
install -m 0755 "$src" "$target/omp-tg.new"
mv -f "$target/omp-tg.new" "$target/omp-tg"
systemctl restart omp-tg
