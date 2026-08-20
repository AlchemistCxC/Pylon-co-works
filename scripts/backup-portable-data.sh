#!/usr/bin/env bash
# 备份 Pylon portable 数据目录 → 带时间戳备份目录。
# 用法:
#   bash scripts/backup-portable-data.sh                # 默认备份 target/release/data
#   bash scripts/backup-portable-data.sh <data_dir>     # 自定义数据目录
#   bash scripts/backup-portable-data.sh <data_dir> <backup_root>
#
# 注意:
#   - 运行中的 pylon.exe 会持有 sqlite（-wal 未合并），备份可能不一致。
#     建议先 taskkill /IM pylon.exe /F 再备份；脚本会检测并警告。
#   - cargo clean 会清掉整个 target/（含 data/）——养成备份习惯。

set -euo pipefail

DATA_DIR="${1:-src-tauri/target/release/data}"
BACKUP_ROOT="${2:-backups/portable-data}"

if [ ! -d "$DATA_DIR" ]; then
  echo "✗ 数据目录不存在: $DATA_DIR" >&2
  exit 1
fi

if tasklist 2>/dev/null | grep -qi pylon.exe; then
  echo "⚠ pylon.exe 正在运行——sqlite 可能有未合并的 -wal，备份可能不一致。建议先关闭再备份。" >&2
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_ROOT/$STAMP"
mkdir -p "$DEST"

# 复制全部内容（含隐藏文件/目录）
cp -r "$DATA_DIR/." "$DEST/"

echo "✓ 备份完成: $DEST"
du -sh "$DEST" | awk '{print "  大小:", $1}'
