#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

PORT="${PORT:-8787}"
HOST="${HOST:-127.0.0.1}"
PID_FILE="${ROOT_DIR}/.capture-server.pid"
CAPTURE_DIR="${CAPTURE_DIR:-${ROOT_DIR}/capture}"
LOG_FILE="${CAPTURE_DIR}/server.log"
SERVER_SCRIPT="${ROOT_DIR}/dist/capture-server.js"

mkdir -p "${CAPTURE_DIR}"

is_running() {
  if [[ -f "${PID_FILE}" ]]; then
    local pid
    pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

start_server() {
  if is_running; then
    local pid
    pid="$(cat "${PID_FILE}")"
    echo "Mock capture server is already running (PID: ${pid}, http://${HOST}:${PORT}/v1)"
    return 0
  fi

  if [[ ! -f "${SERVER_SCRIPT}" ]]; then
    echo "Compiled server script not found: ${SERVER_SCRIPT}"
    echo "Building project with npm run build..."
    (cd "${ROOT_DIR}" && npm run build)
  fi

  echo "Starting mock capture server on http://${HOST}:${PORT}/v1..."
  PORT="${PORT}" CAPTURE_DIR="${CAPTURE_DIR}" node "${SERVER_SCRIPT}" >> "${LOG_FILE}" 2>&1 &
  local new_pid=$!
  echo "${new_pid}" > "${PID_FILE}"

  # Wait for server readiness
  local waited=0
  local max_wait=5
  local ready=0
  while [[ ${waited} -lt ${max_wait} ]]; do
    if curl -s "http://${HOST}:${PORT}/healthz" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.5
    waited=$((waited + 1))
  done

  if [[ ${ready} -eq 1 ]]; then
    echo "Mock capture server started successfully (PID: ${new_pid})"
    echo "Endpoint:    http://${HOST}:${PORT}/v1"
    echo "Captures:    ${CAPTURE_DIR}"
    echo "Server logs: ${LOG_FILE}"
    echo "Inspect:     curl -s http://${HOST}:${PORT}/v1/captures/latest | jq ."
  else
    echo "Server process started (PID: ${new_pid}) but failed healthcheck within ${max_wait}s."
    echo "Check logs: ${LOG_FILE}"
    return 1
  fi
}

stop_server() {
  if ! is_running; then
    if [[ -f "${PID_FILE}" ]]; then
      rm -f "${PID_FILE}"
    fi
    echo "Mock capture server is not running."
    return 0
  fi

  local pid
  pid="$(cat "${PID_FILE}")"
  echo "Stopping mock capture server (PID: ${pid})..."

  kill "${pid}" 2>/dev/null || true

  local waited=0
  local max_wait=10
  while kill -0 "${pid}" 2>/dev/null && [[ ${waited} -lt ${max_wait} ]]; do
    sleep 0.5
    waited=$((waited + 1))
  done

  if kill -0 "${pid}" 2>/dev/null; then
    echo "Process ${pid} did not exit gracefully; sending SIGKILL..."
    kill -9 "${pid}" 2>/dev/null || true
  fi

  rm -f "${PID_FILE}"
  echo "Mock capture server stopped."
}

status_server() {
  if is_running; then
    local pid
    pid="$(cat "${PID_FILE}")"
    local health
    health="$(curl -s "http://${HOST}:${PORT}/healthz" 2>/dev/null || echo '{"status":"unresponsive"}')"
    echo "Mock capture server is RUNNING"
    echo "PID:      ${pid}"
    echo "Endpoint: http://${HOST}:${PORT}/v1"
    echo "Health:   ${health}"
    echo "Logs:     ${LOG_FILE}"
  else
    echo "Mock capture server is STOPPED"
    if [[ -f "${PID_FILE}" ]]; then
      echo "Stale PID file detected (${PID_FILE}). Removing..."
      rm -f "${PID_FILE}"
    fi
  fi
}

logs_server() {
  if [[ ! -f "${LOG_FILE}" ]]; then
    echo "Log file does not exist yet: ${LOG_FILE}"
    return 0
  fi
  tail -n 50 -f "${LOG_FILE}"
}

cmd="${1:-}"

case "${cmd}" in
  start)
    start_server
    ;;
  stop)
    stop_server
    ;;
  restart)
    stop_server
    start_server
    ;;
  status)
    status_server
    ;;
  logs)
    logs_server
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs}"
    exit 1
    ;;
esac
