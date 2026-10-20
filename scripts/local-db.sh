#!/usr/bin/env bash
# Holdline's own local Postgres 18 for development and integration tests.
# Lives in ./.pg (git-ignored), listens on localhost:55433 only, trust auth (local dev only).
# Port 55433 avoids clashing with other local Postgres servers on 5432/5433.
# Usage: scripts/local-db.sh init|start|stop|status
set -euo pipefail
# Without a valid locale the postmaster refuses to start on macOS ("became multithreaded").
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

cd "$(dirname "$0")/.."
DATA_DIR="$PWD/.pg"
PORT=55433

case "${1:-}" in
  init)
    if [ -f "$DATA_DIR/PG_VERSION" ]; then echo "already initialized: $DATA_DIR"; exit 0; fi
    initdb -D "$DATA_DIR" --username=postgres --auth=trust --encoding=UTF8 --locale=C >/dev/null
    echo "initialized $DATA_DIR"
    ;;
  start)
    pg_ctl -D "$DATA_DIR" -l "$DATA_DIR/server.log" -w \
      -o "-p $PORT -c listen_addresses=localhost -c unix_socket_directories=''" start
    for db in holdline holdline_test; do
      psql -h localhost -p "$PORT" -U postgres -d postgres -Atqc "select 1 from pg_database where datname='$db'" | grep -q 1 \
        || createdb -h localhost -p "$PORT" -U postgres "$db"
    done
    echo "postgres running on localhost:$PORT (databases: holdline, holdline_test)"
    ;;
  stop)
    pg_ctl -D "$DATA_DIR" -w stop
    ;;
  status)
    pg_ctl -D "$DATA_DIR" status
    ;;
  *)
    echo "usage: $0 init|start|stop|status" >&2
    exit 1
    ;;
esac
