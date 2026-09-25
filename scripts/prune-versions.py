#!/usr/bin/env python3
# 打包产物清理：同一类安装包只留最近 N 个版本。
#
# electron-builder 每打一次包就往输出目录放一个「Yu Code Setup <版本>.exe」和它的
# .blockmap，失败的那次还会留下 <名称>-<版本>-x64.nsis.7z，几十次之后就堆成一片。
# 这里按版本号排序（按数字比，不是按字符串，所以 1.0.10 比 1.0.9 新），只保留最新的
# N 个版本（默认 3），其余连同类文件一起删掉。
#
# 用法：
#   python scripts/prune-versions.py                 目录与保留数量都用默认
#   python scripts/prune-versions.py --keep 5        保留最近 5 个版本
#   python scripts/prune-versions.py --dir release2  指定目录
#   python scripts/prune-versions.py --dry-run       只列出要删什么，不动文件
#
# 打包时由 scripts/build.js 在最后一步调用；单独跑也可以。
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 产品名里可能带空格，所以不写死前缀，只认末尾那个 x.y.z
ARTIFACT_PATTERNS = (
    re.compile(r'^(?P<name>.*?)\s+(?P<version>\d+\.\d+\.\d+)\.exe(\.blockmap)?$'),
    re.compile(r'^(?P<name>.*?)-(?P<version>\d+\.\d+\.\d+)-[^-]+\.nsis\.7z$'),
)


def default_dir() -> str:
    """和 electron-builder 保持一致：目录写在 electron-builder.json 里"""
    try:
        cfg = json.loads((ROOT / 'electron-builder.json').read_text('utf-8'))
        return cfg.get('directories', {}).get('output') or 'release'
    except (OSError, ValueError):
        return 'release'


def version_key(version: str):
    return tuple(int(part) for part in version.split('.'))


def collect(out_dir: Path):
    """{版本: [文件]}，只挑安装包和它的同版产物"""
    found = {}
    for entry in out_dir.iterdir():
        if not entry.is_file():
            continue
        for pattern in ARTIFACT_PATTERNS:
            m = pattern.match(entry.name)
            if m:
                found.setdefault(m['version'], []).append(entry)
                break
    return found


def has_installer(files) -> bool:
    """这个版本是否真出了安装包。打包失败时只会留下 nsis.7z，那种不算一个版本"""
    return any(f.name.endswith('.exe') for f in files)


def main() -> int:
    # 管道 / 重定向时 Python 默认用本地编码，中文会乱码，这里统一按 UTF-8 输出
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except (AttributeError, OSError):
        pass

    parser = argparse.ArgumentParser(description='只保留最近 N 个版本的安装包')
    parser.add_argument('--dir', default=None, help='产物目录，默认取 electron-builder.json 里的配置')
    parser.add_argument('--keep', type=int, default=3, help='保留几个版本，默认 3')
    parser.add_argument('--dry-run', action='store_true', help='只列出要删的文件，不实际删除')
    args = parser.parse_args()

    if args.keep < 1:
        print(f'[prune] --keep 至少是 1，收到 {args.keep}', file=sys.stderr)
        return 1

    out_dir = Path(args.dir) if args.dir else ROOT / default_dir()
    if not out_dir.is_absolute():
        out_dir = (ROOT / out_dir).resolve()
    if not out_dir.is_dir():
        print(f'[prune] 目录不存在，跳过：{out_dir}')
        return 0

    found = collect(out_dir)
    versions = sorted(found, key=version_key)
    # 只按「有安装包」的版本排，失败构建留下的残渣（只有 nsis.7z）不算版本，直接清掉
    shipped = sorted((v for v in versions if has_installer(found[v])), key=version_key)
    orphans = [v for v in versions if v not in shipped]
    keep = shipped[len(shipped) - args.keep:] if len(shipped) > args.keep else shipped
    doomed = orphans + [v for v in shipped if v not in keep]

    if not doomed:
        print(f'[prune] {out_dir.name}：{len(shipped)} 个版本，无需清理')
        return 0

    freed = 0
    for version in doomed:
        for f in found[version]:
            size = f.stat().st_size
            if args.dry_run:
                print(f'[prune] 将删除 {f.name}（{size / 1048576:.1f} MB）')
                freed += size
                continue
            try:
                f.unlink()
                freed += size
                print(f'[prune] 已删除 {f.name}')
            except OSError as e:
                print(f'[prune] 删除失败 {f.name}：{e}', file=sys.stderr)

    verb = '将清理' if args.dry_run else '已清理'
    print(f'[prune] {out_dir.name}：{verb} {len(doomed)} 个旧版本（{freed / 1048576:.1f} MB），'
          f'保留 {"、".join(keep) or "无"}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
