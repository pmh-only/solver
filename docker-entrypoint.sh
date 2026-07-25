#!/bin/sh
set -eu

docker_socket=${DOCKER_SOCKET_PATH:-/var/run/docker.sock}

if [ -S "$docker_socket" ]; then
  chmod 666 "$docker_socket"
else
  (
    attempts=0
    while [ ! -S "$docker_socket" ] && [ "$attempts" -lt 300 ]; do
      sleep 0.1
      attempts=$((attempts + 1))
    done

    if [ -S "$docker_socket" ]; then
      chmod 666 "$docker_socket"
    fi
  ) &
fi

exec gosu node "$@"
