#!/usr/bin/env bash
# ============================================================
#  LibreChat 生产部署脚本 — BMW 内网
#  用法:
#    ./deploy/deploy.sh           # 构建并启动
#    ./deploy/deploy.sh --pull    # 拉取最新代码后构建并启动
#    ./deploy/deploy.sh --restart # 仅重启（不重新构建）
#    ./deploy/deploy.sh --down    # 停止并移除容器
#    ./deploy/deploy.sh --status  # 查看运行状态
# ============================================================
set -euo pipefail

# ── 配置 ──────────────────────────────────────────────────────
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.prod.yml"
ENV_FILE="$PROJECT_ROOT/.env"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ── 前置检查 ──────────────────────────────────────────────────
check_prerequisites() {
  command -v docker >/dev/null 2>&1 || { err "docker not found"; exit 1; }
  docker compose version >/dev/null 2>&1 || { err "docker compose v2 not found"; exit 1; }
  [[ -f "$ENV_FILE" ]] || { err ".env not found at $ENV_FILE"; exit 1; }
  [[ -f "$COMPOSE_FILE" ]] || { err "$COMPOSE_FILE not found"; exit 1; }

  # 检查宿主机 MongoDB 是否可达（容器通过 host.docker.internal 访问）
  if ! docker run --rm --add-host=host.docker.internal:host-gateway \
       alpine sh -c 'nc -z -w3 host.docker.internal 27017' 2>/dev/null; then
    warn "MongoDB on host.docker.internal:27017 not reachable."
    warn "Ensure MongoDB is running and bound to 0.0.0.0 (not just 127.0.0.1)."
    warn "Check: netstat -ano | grep 27017"
  fi

  log "Prerequisites check passed."
}

# ── 命令 ──────────────────────────────────────────────────────
cmd_build_up() {
  log "Building images..."
  docker compose -f "$COMPOSE_FILE" build

  log "Starting containers..."
  docker compose -f "$COMPOSE_FILE" up -d

  log "Waiting for health checks..."
  sleep 5
  cmd_status

  log "Deployment complete."
  log "Access: http://localhost  (or http://10.165.22.10)"
}

cmd_restart() {
  log "Restarting containers (no rebuild)..."
  docker compose -f "$COMPOSE_FILE" up -d --no-build

  sleep 3
  cmd_status
}

cmd_pull_build() {
  log "Pulling latest code..."
  cd "$PROJECT_ROOT"
  git pull --ff-only

  log "Rebuilding and restarting..."
  docker compose -f "$COMPOSE_FILE" build
  docker compose -f "$COMPOSE_FILE" up -d

  sleep 5
  cmd_status
}

cmd_down() {
  warn "Stopping and removing containers..."
  docker compose -f "$COMPOSE_FILE" down
  log "Containers stopped."
}

cmd_status() {
  log "Container status:"
  docker compose -f "$COMPOSE_FILE" ps
  echo ""
  log "Health check:"
  curl -fsS http://localhost/health 2>/dev/null && echo " OK" || warn "API not responding yet"
}

cmd_logs() {
  docker compose -f "$COMPOSE_FILE" logs -f --tail=100 "${1:-}"
}

# ── 入口 ──────────────────────────────────────────────────────
check_prerequisites

case "${1:-up}" in
  --pull)   cmd_pull_build ;;
  --restart) cmd_restart ;;
  --down)   cmd_down ;;
  --status) cmd_status ;;
  --logs)   cmd_logs "${2:-}" ;;
  up|build) cmd_build_up ;;
  *)
    echo "Usage: $0 [--pull|--restart|--down|--status|--logs [service]]"
    exit 1
    ;;
esac
