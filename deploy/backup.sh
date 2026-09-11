#!/usr/bin/env bash
# ============================================================
#  LibreChat MongoDB 备份脚本 — BMW 内网
#  MongoDB 在宿主机运行（不在容器内），所以直接用本机的 mongodump
#
#  用法:
#    ./deploy/backup.sh                    # 立即备份一次
#    ./deploy/backup.sh --list             # 列出所有备份
#    ./deploy/backup.sh --prune 7          # 保留最近 7 天的备份
#    ./deploy/backup.sh --restore <file>    # 从备份恢复
#
#  定时备份（Windows Task Scheduler）:
#    创建任务，每天 02:00 执行:
#    "C:\Program Files\Git\bin\bash.exe" -c "cd /c/Users/q446328/Desktop/LibreChat && bash deploy/backup.sh"
# ============================================================
set -euo pipefail

# ── 配置 ──────────────────────────────────────────────────────
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$PROJECT_ROOT/backups"
DB_NAME="LibreChat"

# MongoDB 连接 URI（从 .env 读取，回退到默认值）
ENV_FILE="$PROJECT_ROOT/.env"
MONGO_URI=$(grep -E '^MONGO_URI=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || echo "")
MONGO_URI="${MONGO_URI:-mongodb://127.0.0.1:27017/LibreChat}"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
log()  { echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ── 检查 mongodump 是否可用 ────────────────────────────────────
check_mongodump() {
  command -v mongodump >/dev/null 2>&1 || {
    err "mongodump not found in PATH"
    err "Install MongoDB Database Tools, or add its bin/ to PATH"
    exit 1
  }
  command -v mongorestore >/dev/null 2>&1 || {
    err "mongorestore not found in PATH"
    exit 1
  }
}

# ── 备份 ──────────────────────────────────────────────────────
do_backup() {
  mkdir -p "$BACKUP_DIR"
  local timestamp
  timestamp=$(date '+%Y%m%d_%H%M%S')
  local dump_dir="$BACKUP_DIR/dump_$timestamp"
  local archive="$BACKUP_DIR/librechat_${timestamp}.tar.gz"

  log "Starting MongoDB backup..."
  log "URI: ${MONGO_URI%%@*}@<hidden>"

  mongodump --uri="$MONGO_URI" --out="$dump_dir" \
    || { err "mongodump failed"; exit 1; }

  tar czf "$archive" -C "$BACKUP_DIR" "dump_$timestamp"
  rm -rf "$dump_dir"

  local size
  size=$(du -h "$archive" | cut -f1)
  log "Backup complete: $archive ($size)"
}

# ── 恢复 ──────────────────────────────────────────────────────
do_restore() {
  local archive="$1"
  [[ -f "$archive" ]] || { err "Backup file not found: $archive"; exit 1; }

  warn "This will OVERWRITE the current database."
  read -rp "Type 'yes' to continue: " confirm
  [[ "$confirm" == "yes" ]] || { log "Restore cancelled."; exit 0; }

  log "Restoring from: $archive"

  local tmp_dir
  tmp_dir=$(mktemp -d)
  tar xzf "$archive" -C "$tmp_dir"

  mongorestore --uri="$MONGO_URI" --drop "$tmp_dir/dump_"*/ \
    || { err "mongorestore failed"; rm -rf "$tmp_dir"; exit 1; }

  rm -rf "$tmp_dir"
  log "Restore complete."
}

# ── 列出备份 ──────────────────────────────────────────────────
do_list() {
  log "Available backups:"
  ls -lh "$BACKUP_DIR"/librechat_*.tar.gz 2>/dev/null || echo "  (no backups found)"
}

# ── 清理旧备份 ────────────────────────────────────────────────
do_prune() {
  local days="${1:-7}"
  log "Pruning backups older than $days days..."
  find "$BACKUP_DIR" -name "librechat_*.tar.gz" -mtime +"$days" -delete 2>/dev/null || true
  log "Pruned backups older than $days days."
}

# ── 入口 ──────────────────────────────────────────────────────
check_mongodump

case "${1:-backup}" in
  backup)        do_backup ;;
  --restore)     do_restore "${2:-}" ;;
  --list)        do_list ;;
  --prune)       do_prune "${2:-7}" ;;
  *)
    echo "Usage: $0 [backup|--restore <file>|--list|--prune <days>]"
    exit 1
    ;;
esac
