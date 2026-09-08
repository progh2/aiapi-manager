#!/usr/bin/env python3
"""학생 명단 CSV로 LiteLLM 가상 키를 일괄 발급한다.

사용법:
    python3 issue_keys.py students.csv --base-url http://NAS주소:4000 \
        --master-key sk-... --budget 2.0 --output issued_keys.csv

CSV 형식 (헤더 필수): name,student_id
발급 결과는 --output 파일에 name,student_id,api_key로 저장된다.
표준 라이브러리만 사용하므로 pip 설치 없이 동작한다.
"""
import argparse
import csv
import json
import sys
import urllib.request


def issue_key(base_url: str, master_key: str, alias: str, budget: float,
              duration: str | None, models: list[str]) -> str:
    payload = {
        "key_alias": alias,
        "max_budget": budget,
        "budget_duration": duration,  # 예: "30d" (None이면 총액 한도)
        "models": models or [],
    }
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/key/generate",
        data=json.dumps({k: v for k, v in payload.items() if v}).encode(),
        headers={
            "Authorization": f"Bearer {master_key}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)["key"]


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("csv_file", help="name,student_id 헤더를 가진 학생 명단 CSV")
    p.add_argument("--base-url", required=True, help="LiteLLM 프록시 주소")
    p.add_argument("--master-key", required=True, help="LITELLM_MASTER_KEY")
    p.add_argument("--budget", type=float, default=2.0, help="키당 예산(USD), 기본 2.0")
    p.add_argument("--budget-duration", default=None,
                   help='예산 주기. 예: "30d". 생략하면 총액 한도')
    p.add_argument("--models", nargs="*", default=["gpt-4o-mini"],
                   help="허용 모델 목록, 기본 gpt-4o-mini")
    p.add_argument("--output", default="issued_keys.csv", help="발급 결과 CSV")
    args = p.parse_args()

    with open(args.csv_file, newline="", encoding="utf-8") as f:
        students = list(csv.DictReader(f))
    if not students or "name" not in students[0] or "student_id" not in students[0]:
        sys.exit("CSV에 name,student_id 헤더가 필요합니다")

    with open(args.output, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["name", "student_id", "api_key"])
        for s in students:
            alias = f"{s['student_id']}-{s['name']}"
            try:
                key = issue_key(args.base_url, args.master_key, alias,
                                args.budget, args.budget_duration, args.models)
            except Exception as e:
                print(f"실패: {alias}: {e}", file=sys.stderr)
                continue
            writer.writerow([s["name"], s["student_id"], key])
            print(f"발급: {alias}")

    print(f"\n결과 저장: {args.output} (배포 후 이 파일은 안전하게 보관/삭제)")


if __name__ == "__main__":
    main()
