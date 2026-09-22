#!/usr/bin/env python3
"""캠프 키를 당일 종료 후 차단·회수한다.

LiteLLM /key/list → /key/block(또는 /key/delete). 학급 키는 건드리지 않는다.
cron 예: 매일 00:05 에 어제 캠프 키를 막는다.

    python3 revoke_camp_keys.py --base-url http://NAS주소:4000 \
        --master-key $LITELLM_MASTER_KEY --when due --action block

--when:
  due   만료된 캠프(어제 이전, 기본). 스케줄 훅
  today 오늘 발급한 캠프. 수업이 일찍 끝났을 때 수동
  all   캠프 키 전체
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime


def api(base_url: str, master_key: str, path: str, payload: dict | None = None):
    data = None
    if payload is not None:
        data = json.dumps({k: v for k, v in payload.items() if v is not None}).encode()
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}{path}",
        data=data,
        headers={
            "Authorization": f"Bearer {master_key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:300]
        raise RuntimeError(f"HTTP {e.code}: {detail}") from None


def today_ymd(now: datetime | None = None) -> str:
    d = now or datetime.now()
    return f"{d.year:04d}-{d.month:02d}-{d.day:02d}"


def camp_meta(key: dict) -> dict:
    meta = (key or {}).get("metadata") or {}
    return meta.get("aiapi_camp") or {}


def is_camp_key(key: dict) -> bool:
    camp = camp_meta(key)
    return bool(camp.get("kind") == "camp" or camp.get("code") or camp.get("expires_ymd"))


def parse_expires(key: dict) -> datetime | None:
    raw = (key or {}).get("expires")
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None


def is_expired(key: dict, now: datetime | None = None) -> bool:
    d = parse_expires(key)
    if not d:
        return False
    cur = now if now is not None else datetime.now()
    if d.tzinfo is not None and cur.tzinfo is None:
        cur = cur.replace(tzinfo=d.tzinfo)
    elif d.tzinfo is None and cur.tzinfo is not None:
        cur = cur.replace(tzinfo=None)
    return d < cur


def is_camp_due(key: dict, now: datetime | None = None) -> bool:
    if not is_camp_key(key):
        return False
    cur = now or datetime.now()
    if is_expired(key, cur):
        return True
    ymd = camp_meta(key).get("expires_ymd")
    return bool(ymd and ymd < today_ymd(cur.replace(tzinfo=None) if getattr(cur, "tzinfo", None) else cur))


def is_camp_today(key: dict, now: datetime | None = None) -> bool:
    if not is_camp_key(key):
        return False
    cur = now or datetime.now()
    ymd = camp_meta(key).get("expires_ymd")
    if ymd:
        return ymd == today_ymd(cur.replace(tzinfo=None) if getattr(cur, "tzinfo", None) else cur)
    return not is_expired(key, cur)


def matches_when(key: dict, when: str, now: datetime | None = None) -> bool:
    if when == "all":
        return is_camp_key(key)
    if when == "today":
        return is_camp_today(key, now)
    return is_camp_due(key, now)


def list_all_keys(base_url: str, master_key: str) -> list[dict]:
    keys: list[dict] = []
    page = 1
    while True:
        data = api(base_url, master_key, f"/key/list?return_full_object=true&size=100&page={page}")
        keys.extend(data.get("keys") or [])
        total = data.get("total_pages") or 1
        if page >= total:
            break
        page += 1
    return keys


def key_token(key: dict) -> str:
    return (key or {}).get("token") or (key or {}).get("key") or ""


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="캠프 키 당일 종료 회수")
    p.add_argument("--base-url", required=True, help="LiteLLM 주소 (예: http://127.0.0.1:4000)")
    p.add_argument("--master-key", required=True, help="LITELLM_MASTER_KEY")
    p.add_argument("--when", choices=("due", "today", "all"), default="due")
    p.add_argument("--action", choices=("block", "delete"), default="block")
    p.add_argument("--dry-run", action="store_true", help="막을 키만 출력")
    args = p.parse_args(argv)

    keys = [k for k in list_all_keys(args.base_url, args.master_key) if matches_when(k, args.when)]
    if not keys:
        print("조건에 맞는 캠프 키가 없습니다", file=sys.stderr)
        return 0

    fail = 0
    for k in keys:
        token = key_token(k)
        alias = k.get("key_alias") or token[:16]
        if args.dry_run:
            print(f"DRY {args.action}\t{alias}\t{token}")
            continue
        if k.get("blocked") and args.action == "block":
            print(f"SKIP\t{alias}\t이미 차단됨")
            continue
        try:
            if args.action == "block":
                api(args.base_url, args.master_key, "/key/block", {"key": token})
                print(f"BLOCK\t{alias}")
            else:
                api(args.base_url, args.master_key, "/key/delete", {"keys": [token]})
                print(f"DELETE\t{alias}")
        except RuntimeError as e:
            fail += 1
            print(f"FAIL\t{alias}\t{e}", file=sys.stderr)
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
