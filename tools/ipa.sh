#!/usr/bin/env bash
# 出包: 找/触发 CI → 等绿 → oci 从 GitHub 下载并发布 SideStore 源（和 Conch 同一台 oci、同一令牌，子目录 verso/）
# 用法: tools/ipa.sh        （要求当前提交已 push）
set -euo pipefail
R=JHdehao/Verso; W=build-ipa.yml
cd "$(dirname "$0")/.."
git fetch -q origin main
sha=$(git rev-parse HEAD)
git merge-base --is-ancestor "$sha" origin/main || { echo "HEAD 未 push 到 origin/main"; exit 1; }

find_run() { gh run list -R $R -w $W --commit "$sha" --json databaseId -q '.[0].databaseId // empty'; }
id=$(find_run)
for _ in 1 2 3; do [ -n "$id" ] && break; sleep 5; id=$(find_run); done
if [ -z "$id" ]; then   # push 没触发（改动不在 paths 内）→ 手动触发，跑在 main 最新提交上
  [ "$sha" = "$(git rev-parse origin/main)" ] || { echo "手动触发只能跑 main 最新提交"; exit 1; }
  gh workflow run $W -R $R --ref main
  for _ in 1 2 3 4 5 6; do sleep 5; id=$(find_run); [ -n "$id" ] && break; done
fi
[ -n "$id" ] || { echo "找不到运行记录"; exit 1; }

n=$(gh run view "$id" -R $R --json number -q .number)
echo "run $id @ ${sha:0:7} → 手机 设置 页底部应显示 (build $n) · ${sha:0:7}"
gh run watch "$id" -R $R --exit-status >/dev/null || {
  gh run view "$id" -R $R --log-failed | grep -E "error:|BUILD FAILED" | sed -E 's#^.*/Verso/Verso/##' | sort -u | head -40
  exit 1
}
aid=$(gh api "repos/$R/actions/runs/$id/artifacts" -q '.artifacts[]|select(.name=="Verso-unsigned-ipa").id')
url=$(curl -s -m 30 -o /dev/null -D - -H "Authorization: Bearer $(gh auth token)" \
  "https://api.github.com/repos/$R/actions/artifacts/$aid/zip" | awk 'tolower($1)=="location:"{print $2}' | tr -d '\r')
[ -n "$url" ] || { echo "拿不到产物的下载地址"; exit 1; }
T=$(cat ~/.config/conch/sidestore-token)   # 令牌在仓库外（仓库是公开的）
scp -q tools/sidestore-source.py oci:verso-sidestore-source.py
scp -q tools/oci-publish.sh oci:verso-publish.sh
scp -q App/Assets.xcassets/AppIcon.appiconset/icon-1024.png oci:verso-icon-1024.png
printf '%s\n%s\n' "$url" "$(git log -1 --format=%s "$sha")" | ssh oci bash verso-publish.sh "$T" "${sha:0:7}" | sed "s#$T#<令牌>#g"
