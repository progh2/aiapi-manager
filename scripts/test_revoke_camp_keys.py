#!/usr/bin/env python3
"""revoke_camp_keys 필터 단위 테스트. 네트워크 없이 동작."""
import unittest
from datetime import datetime

from revoke_camp_keys import is_camp_due, is_camp_key, is_camp_today, matches_when


NOW = datetime(2026, 9, 17, 12, 0, 0)


def key(alias, *, expires=None, ymd=None, camp=True, blocked=False):
    rec = {
        "token": f"sk-{alias}",
        "key_alias": alias,
        "expires": expires,
        "blocked": blocked,
    }
    if camp:
        rec["metadata"] = {
            "aiapi_camp": {"kind": "camp", "code": alias, "expires_ymd": ymd}
        }
    return rec


class CampFilterTest(unittest.TestCase):
    def test_only_metadata_is_camp(self):
        self.assertTrue(is_camp_key(key("CAMP-A7K2", ymd="2026-09-17")))
        self.assertFalse(is_camp_key(key("20261001-홍길동", camp=False)))

    def test_due_is_yesterday(self):
        past = key("CAMP-OLD", expires="2026-09-16T14:59:59", ymd="2026-09-16")
        today = key("CAMP-NEW", expires="2026-09-17T14:59:59", ymd="2026-09-17")
        klass = key("20261001-홍길동", expires="2026-09-16T14:59:59", camp=False)
        self.assertTrue(is_camp_due(past, NOW))
        self.assertFalse(is_camp_due(today, NOW))
        self.assertFalse(is_camp_due(klass, NOW))
        self.assertTrue(is_camp_today(today, NOW))
        self.assertFalse(is_camp_today(past, NOW))

    def test_when_filters(self):
        past = key("CAMP-OLD", expires="2026-09-16T14:59:59", ymd="2026-09-16")
        today = key("CAMP-NEW", expires="2026-09-17T14:59:59", ymd="2026-09-17")
        self.assertTrue(matches_when(past, "due", NOW))
        self.assertFalse(matches_when(today, "due", NOW))
        self.assertTrue(matches_when(today, "today", NOW))
        self.assertTrue(matches_when(past, "all", NOW))
        self.assertFalse(matches_when(key("학급", camp=False), "all", NOW))


if __name__ == "__main__":
    unittest.main()
