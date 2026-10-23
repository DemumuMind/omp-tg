#!/bin/sh
set -eu
user="${OMP_USER:-omp}"
bin="${OMP_BIN:-/home/omp/.local/bin/omp}"
runuser -u "$user" -- "$bin" update --stable
systemctl restart omp-tg
