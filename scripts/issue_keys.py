#!/usr/bin/env python3
"""학생 명단 CSV로 LiteLLM 가상 키를 일괄 발급한다.

사용법:
    python3 issue_keys.py students.csv --base-url http://NAS주소:4000 \
        --master-key sk-... --budget 2.0 --output issued_keys.csv

그룹(팀)에 소속시키려면 --team 을 준다. 같은 이름의 그룹이 있으면 거기에 넣고,
없으면 새로 만든다 (--team-budget 으로 그룹 전체 예산 지정 가능).

    python3 issue_keys.py students.csv --base-url ... --master-key ... \
        --team 3학년A반 --team-budget 60 --duration 90d

CSV 형식: 헤더 `name,student_id` 또는 `학번,이름` (어느 쪽이든 됨).
헤더가 없으면 첫 칸이 숫자면 학번,이름으로 본다.
발급 결과는 --output 파일에 name,student_id,api_key로 저장된다.
표준 라이브러리만 사용하므로 pip 설치 없이 동작한다.
"""
import argparse
import csv
import json
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime


def api(base_url: str, master_key: str, path: str, payload: dict | None = None):
    """LiteLLM 관리 API 호출. payload가 있으면 POST, 없으면 GET."""
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


NAME_HEADERS = {"name", "이름", "성명", "학생", "학생이름", "student_name", "studentname"}
ID_HEADERS = {"student_id", "studentid", "학번", "id", "번호", "sid"}


def _norm_header(h: str) -> str:
    return (h or "").lstrip("\ufeff").strip().lower().replace(" ", "_").replace("-", "_")


def _looks_like_id(value: str) -> bool:
    return bool(re.fullmatch(r"\d{4,}", (value or "").strip()))


def duration_from_expiry(date_str: str) -> str:
    """YYYY-MM-DD → 그날 23:59:59까지의 초를 LiteLLM duration으로."""
    try:
        y, m, d = [int(p) for p in date_str.split("-")]
        end = datetime(y, m, d, 23, 59, 59)
    except ValueError:
        raise SystemExit("만료일은 YYYY-MM-DD 형식이어야 합니다") from None
    seconds = int((end - datetime.now()).total_seconds())
    if seconds <= 0:
        raise SystemExit("만료일은 오늘 이후여야 합니다")
    return f"{seconds}s"


def load_students(path: str) -> list[dict]:
    """name,student_id / 학번,이름 / 헤더 없는 붙여넣기를 학생 dict로 바꾼다."""
    with open(path, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))
    students = []
    if not rows:
        raise SystemExit("CSV가 비어 있습니다")
    headers = [_norm_header(c) for c in rows[0]]
    name_idx = next((i for i, h in enumerate(headers) if h in NAME_HEADERS), None)
    id_idx = next((i for i, h in enumerate(headers) if h in ID_HEADERS), None)
    start = 0
    if name_idx is not None and id_idx is not None:
        start = 1
    for i, row in enumerate(rows[start:], start=start + 1):
        cells = [c.strip() for c in row]
        if not any(cells):
            continue
        if name_idx is not None and id_idx is not None:
            name = cells[name_idx] if name_idx < len(cells) else ""
            sid = cells[id_idx] if id_idx < len(cells) else ""
        elif len(cells) == 1:
            only = cells[0]
            if "-" in only:
                sid, name = only.split("-", 1)
            elif _looks_like_id(only):
                sid, name = only, ""
            else:
                sid, name = "", only
        elif _looks_like_id(cells[0]):
            sid, name = cells[0], " ".join(cells[1:])
        elif len(cells) > 1 and _looks_like_id(cells[1]):
            name, sid = cells[0], cells[1]
        else:
            name, sid = cells[0], cells[1] if len(cells) > 1 else ""
        if not sid and not name:
            print(f"건너뜀 (빈 행 {i})", file=sys.stderr)
            continue
        students.append({"name": name, "student_id": sid})
    if not students:
        raise SystemExit("읽을 수 있는 학생 행이 없습니다")
    return students


def resolve_team(base_url: str, master_key: str, team: str,
                 team_budget: float | None, models: list | None = None) -> str:
    """그룹 이름을 team_id로 바꾼다. 이미 team_id면 그대로, 없는 이름이면 생성."""
    listing = api(base_url, master_key, "/team/list")
    teams = listing if isinstance(listing, list) else listing.get("teams", [])
    for t in teams:
        if team in (t.get("team_alias"), t.get("team_id")):
            print(f"기존 그룹 사용: {t.get('team_alias')} ({t['team_id'][:8]}…)")
            return t["team_id"]
    payload = {"team_alias": team, "max_budget": team_budget}
    if models:
        payload["models"] = models
    created = api(base_url, master_key, "/team/new", payload)
    print(f"그룹 생성: {team} ({created['team_id'][:8]}…)"
          + (f", 그룹 예산 ${team_budget}" if team_budget else ""))
    return created["team_id"]


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("csv_file", help="name,student_id 또는 학번,이름 헤더의 학생 명단 CSV")
    p.add_argument("--base-url", required=True, help="LiteLLM 프록시 주소")
    p.add_argument("--master-key", required=True, help="LITELLM_MASTER_KEY")
    p.add_argument("--budget", type=float, default=2.0, help="키당 예산(USD), 기본 2.0")
    p.add_argument("--budget-duration", default=None,
                   help='예산 리셋 주기. 예: "30d". 생략하면 총액 한도')
    p.add_argument("--duration", default=None,
                   help='키 만료 기한. 예: "90d"(한 학기). 생략하면 무기한')
    p.add_argument("--expires", default=None,
                   help="달력 만료일 YYYY-MM-DD (그날 23:59:59). --duration보다 우선")
    p.add_argument("--rpm", type=int, default=None, help="분당 요청 제한. 생략하면 무제한")
    p.add_argument("--tpm", type=int, default=None, help="분당 토큰 제한. 생략하면 무제한")
    p.add_argument("--team", default=None,
                   help="소속 그룹 이름 또는 team_id. 이름이면 자동 조회하고, 없으면 새로 만든다")
    p.add_argument("--team-budget", type=float, default=None,
                   help="--team으로 그룹을 새로 만들 때 적용할 그룹 전체 예산(USD)")
    p.add_argument("--models", nargs="*", default=["gpt-4o-mini"],
                   help="허용 모델 목록, 기본 gpt-4o-mini")
    p.add_argument("--output", default="issued_keys.csv", help="발급 결과 CSV")
    args = p.parse_args()

    try:
        students = load_students(args.csv_file)
    except Exception as e:
        sys.exit(str(e))

    duration = args.duration
    if args.expires:
        try:
            duration = duration_from_expiry(args.expires)
        except Exception as e:
            sys.exit(str(e))

    team_id = None
    if args.team:
        try:
            team_id = resolve_team(args.base_url, args.master_key,
                                   args.team, args.team_budget, args.models)
        except Exception as e:
            sys.exit(f"그룹 준비 실패: {e}")

    ok, fail = 0, 0
    with open(args.output, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["name", "student_id", "api_key"])
        for s in students:
            alias = f"{s['student_id']}-{s['name']}" if s["student_id"] and s["name"] else (
                s["student_id"] or s["name"])
            try:
                resp = api(args.base_url, args.master_key, "/key/generate", {
                    "key_alias": alias,
                    "max_budget": args.budget,
                    "budget_duration": args.budget_duration,
                    "duration": duration,
                    "models": args.models or [],
                    "rpm_limit": args.rpm,
                    "tpm_limit": args.tpm,
                    "team_id": team_id,
                })
            except Exception as e:
                fail += 1
                print(f"실패: {alias}: {e}", file=sys.stderr)
                continue
            ok += 1
            writer.writerow([s["name"], s["student_id"], resp["key"]])
            print(f"발급: {alias}")

    print(f"\n성공 {ok}명 · 실패 {fail}건")
    print(f"결과 저장: {args.output} (배포 후 이 파일은 안전하게 보관/삭제)")


if __name__ == "__main__":
    main()
