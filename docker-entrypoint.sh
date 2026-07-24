#!/bin/sh
set -eu

if [ -S /var/run/docker.sock ]; then
  chmod 666 /var/run/docker.sock
fi

exec gosu node "$@"
