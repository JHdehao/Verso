#!/usr/bin/env python3
"""把 CI 出的 IPA 发布成 Verso 的 SideStore 源。

在 oci 上运行（tools/ipa.sh → tools/oci-publish.sh 调用）：SOURCE_DIR=~/conch-www/<令牌>/verso，
SOURCE_URL=https://jhai.cc.cd/<令牌>/verso。沿用 Conch 已有的 conch-www.service 与 cloudflared 规则（路径 ^/<令牌>/ 覆盖子目录）。
令牌存在仓库外的 ~/.config/conch/sidestore-token（本仓库公开）。
用法: sidestore-source.py <ipa> <提交号> <版本说明>
"""
import datetime
import json
import os
import plistlib
import re
import shutil
import sys
import zipfile
from pathlib import Path

BASE = os.environ["SOURCE_URL"]
DIR = Path(os.environ["SOURCE_DIR"])
ICON = Path(os.environ.get("ICON", Path(__file__).resolve().parent.parent / "App/Assets.xcassets/AppIcon.appiconset/icon-1024.png"))
KEEP = 8  # 连续发版时手机上的源缓存可能落后好几版，留少了会 404（2026-09-30 遇到过）


def app_info(ipa: Path) -> dict:
    with zipfile.ZipFile(ipa) as z:
        name = next(n for n in z.namelist() if re.fullmatch(r"Payload/[^/]+\.app/Info\.plist", n))
        return plistlib.loads(z.read(name))


def main() -> None:
    ipa, commit, notes = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
    DIR.mkdir(parents=True, exist_ok=True)
    info = app_info(ipa)
    build = int(info["CFBundleVersion"])
    shutil.copyfile(ipa, DIR / f"Verso-{build}.ipa")
    (DIR / f"Verso-{build}.json").write_text(json.dumps({
        "version": info["CFBundleShortVersionString"],
        "buildVersion": str(build),
        "date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "localizedDescription": f"{commit} {notes}",
        "downloadURL": f"{BASE}/Verso-{build}.ipa",
        "size": ipa.stat().st_size,
        "minOSVersion": info.get("MinimumOSVersion", "18.0"),
    }, ensure_ascii=False))
    # 1024 的原图 500+ KB，SideStore 加载图标超时短；缩到 256。已有就沿用（oci 上没有仓库里的原图）
    if not (DIR / "icon.png").exists() and ICON.exists():
        try:
            from PIL import Image
            Image.open(ICON).resize((256, 256), Image.LANCZOS).save(DIR / "icon.png", optimize=True)
        except ImportError:
            shutil.copyfile(ICON, DIR / "icon.png")

    # 只留最近 KEEP 个版本
    builds = sorted((int(p.stem.split("-")[1]) for p in DIR.glob("Verso-*.json")), reverse=True)
    for old in builds[KEEP:]:
        for ext in ("ipa", "json"):
            (DIR / f"Verso-{old}.{ext}").unlink(missing_ok=True)
    versions = [json.loads((DIR / f"Verso-{b}.json").read_text()) for b in builds[:KEEP]]
    latest = versions[0]

    app = {
        "name": "Verso",
        "bundleIdentifier": info["CFBundleIdentifier"],
        "developerName": "JH",
        "subtitle": "苹果本机网页翻译",
        "localizedDescription": "Verso 测试版，由 GitHub Actions 编译（Release，无签名，SideStore 安装时自签）。",
        "iconURL": f"{BASE}/icon.png",
        "tintColor": "C96442",
        "versions": versions,
        # AltStore 2 / 新版 SideStore 会核对权限声明；无签名包里没有 entitlements
        "appPermissions": {
            "entitlements": [],
            "privacy": {k: v for k, v in info.items() if k.startswith("NS") and k.endswith("UsageDescription")},
        },
        # 旧版 SideStore（AltStore 1.x 格式）只认这几个字段
        "version": latest["version"],
        "versionDate": latest["date"],
        "versionDescription": latest["localizedDescription"],
        "downloadURL": latest["downloadURL"],
        "size": latest["size"],
    }
    source = {
        "name": "Verso",
        "identifier": "com.tj.verso.source",
        "sourceURL": f"{BASE}/source.json",
        "iconURL": f"{BASE}/icon.png",
        "apps": [app],
        "news": [],
    }
    tmp = DIR / "source.json.tmp"
    tmp.write_text(json.dumps(source, ensure_ascii=False, indent=2))
    tmp.replace(DIR / "source.json")
    print(f"SideStore 源已更新：{latest['version']} (build {build}) → {BASE}/source.json")


if __name__ == "__main__":
    main()
