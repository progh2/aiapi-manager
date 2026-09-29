# 학생 키 metadata.aiapi_schedule 밖의 호출을 거절한다.
# 규칙: admin-ui/lib/schedule.js 와 같다. 서울 시각, 1=월 … 7=일, 종료는 포함하지 않음.
# 창이 없거나 비어 있으면 항상 허용. 여러 창이면 하나라도 겹치면 허용.

from datetime import datetime
from zoneinfo import ZoneInfo

try:
    from litellm.integrations.custom_logger import CustomLogger
except ImportError:  # 로컬 단위 테스트에는 LiteLLM이 없다
    CustomLogger = object

try:
    from fastapi import HTTPException
except ImportError:
    class HTTPException(Exception):
        def __init__(self, status_code, detail):
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail

SEOUL = ZoneInfo("Asia/Seoul")


def _minutes(hhmm):
    text = str(hhmm or "")
    if len(text) != 5 or text[2] != ":":
        return None
    hour, minute = text.split(":")
    if not (hour.isdigit() and minute.isdigit()):
        return None
    h, m = int(hour), int(minute)
    if h > 23 or m > 59:
        return None
    return h * 60 + m


def schedule_allows(schedule, when=None):
    windows = schedule if isinstance(schedule, list) else []
    if not windows:
        return True
    local = (when or datetime.now(SEOUL)).astimezone(SEOUL)
    now_min = local.hour * 60 + local.minute
    iso_day = local.isoweekday()
    for window in windows:
        if not isinstance(window, dict):
            continue
        start = _minutes(window.get("start"))
        end = _minutes(window.get("end"))
        days = window.get("days") or []
        if start is None or end is None:
            continue
        if iso_day in days and start <= now_min < end:
            return True
    return False


def _metadata(user_api_key_dict):
    raw = getattr(user_api_key_dict, "metadata", None)
    if isinstance(raw, dict):
        return raw
    info = getattr(user_api_key_dict, "info", None)
    if isinstance(info, dict) and isinstance(info.get("metadata"), dict):
        return info["metadata"]
    return {}


class AiapiPolicy(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        schedule = _metadata(user_api_key_dict).get("aiapi_schedule") or []
        if schedule_allows(schedule):
            return data
        raise HTTPException(
            status_code=403,
            detail="지금은 이 키를 쓸 수 있는 시간이 아닙니다. 수업 시간대는 한국(서울) 시각 기준입니다.",
        )


proxy_handler_instance = AiapiPolicy()
