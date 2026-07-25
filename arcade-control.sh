#!/usr/bin/env bash
set -u

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="$PROJECT_DIR/.runtime"
mkdir -p "$RUNTIME_DIR"

service_file() {
  case "$1" in
    8080) printf '%s' 'game-launcher.cjs' ;;
    8081) printf '%s' 'game-importer.cjs' ;;
    *) return 1 ;;
  esac
}

port_open() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
}

start_service() {
  local port="$1" file pid_file log_file pid
  file="$(service_file "$port")"
  pid_file="$RUNTIME_DIR/$port.pid"
  log_file="$RUNTIME_DIR/$port.log"

  if port_open "$port"; then
    printf 'Port %s is already running.\n' "$port"
    return 0
  fi

  (
    cd "$PROJECT_DIR" || exit 1
    nohup env PORT="$port" node "$file" >>"$log_file" 2>&1 &
    echo "$!" >"$pid_file"
  )
  pid="$(<"$pid_file")"
  for _ in {1..30}; do
    if port_open "$port"; then
      printf 'Started %s on http://127.0.0.1:%s (PID %s).\n' "$file" "$port" "$pid"
      return 0
    fi
    sleep 0.1
  done
  printf 'Failed to start port %s. See %s\n' "$port" "$log_file" >&2
  return 1
}

stop_service() {
  local port="$1" pid_file="$RUNTIME_DIR/$1.pid" pid
  if [[ ! -f "$pid_file" ]]; then
    printf 'Port %s was not started by this menu; nothing stopped.\n' "$port"
    return 0
  fi
  pid="$(<"$pid_file")"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    printf 'Stopped port %s (PID %s).\n' "$port" "$pid"
  else
    printf 'Saved process for port %s is no longer running.\n' "$port"
  fi
  rm -f "$pid_file"
}

show_status() {
  local port
  for port in 8080 8081; do
    if port_open "$port"; then
      printf '%s: running at http://127.0.0.1:%s\n' "$port" "$port"
    else
      printf '%s: stopped\n' "$port"
    fi
  done
}

show_logs() {
  local port="$1" log_file="$RUNTIME_DIR/$1.log"
  if [[ -f "$log_file" ]]; then
    tail -n 30 "$log_file"
  else
    printf 'No menu-managed log exists for port %s yet.\n' "$port"
  fi
}

while true; do
  printf '\nEGT Arcade control\n'
  printf '  1) Start arcade (8080)\n'
  printf '  2) Start importer (8081)\n'
  printf '  3) Start both\n'
  printf '  4) Show status\n'
  printf '  5) Show recent logs\n'
  printf '  6) Stop menu-managed services\n'
  printf '  0) Exit\n'
  read -r -p 'Choose an option: ' choice
  case "$choice" in
    1) start_service 8080 ;;
    2) start_service 8081 ;;
    3) start_service 8080; start_service 8081 ;;
    4) show_status ;;
    5)
      read -r -p 'Logs for 8080 or 8081? ' log_port
      case "$log_port" in 8080|8081) show_logs "$log_port" ;; *) echo 'Enter 8080 or 8081.' ;; esac
      ;;
    6) stop_service 8080; stop_service 8081 ;;
    0) exit 0 ;;
    *) echo 'Invalid choice.' ;;
  esac
done
