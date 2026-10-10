#!/usr/bin/env bash
# 在 oci 上执行（tools/ipa.sh 经 ssh 调用）：从 GitHub 下载 IPA 产物，发布到 Verso 的 SideStore 源（~/conch-www/<令牌>/verso/）。
# 参数: <令牌> <提交号>；stdin 两行: 产物的临时下载地址、版本说明
set -euo pipefail
T=$1; SHA=$2
read -r URL; read -r NOTES
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
curl -sfL -m 300 -o "$d/a.zip" "$URL"
unzip -q -o "$d/a.zip" -d "$d"
SOURCE_DIR=~/conch-www/$T/verso SOURCE_URL=https://jhai.cc.cd/$T/verso ICON=~/verso-icon-1024.png \
  python3 ~/verso-sidestore-source.py "$d/Verso-unsigned.ipa" "$SHA" "$NOTES"
