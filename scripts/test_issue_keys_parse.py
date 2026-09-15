#!/usr/bin/env python3
"""issue_keys CSV 파서 단위 테스트. 네트워크 없이 동작."""
import os
import tempfile
import unittest

from issue_keys import duration_from_expiry, load_students


class LoadStudentsTest(unittest.TestCase):
    def _write(self, text: str) -> str:
        fd, path = tempfile.mkstemp(suffix=".csv")
        os.close(fd)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        self.addCleanup(os.remove, path)
        return path

    def test_cli_header(self):
        rows = load_students(self._write("name,student_id\n홍길동,20261001\n"))
        self.assertEqual(rows, [{"name": "홍길동", "student_id": "20261001"}])

    def test_ui_header(self):
        rows = load_students(self._write("학번,이름\n20261001,홍길동\n20261002,김철수\n"))
        self.assertEqual(rows[1]["name"], "김철수")
        self.assertEqual(rows[0]["student_id"], "20261001")

    def test_headerless_id_first(self):
        rows = load_students(self._write("20261001,홍길동\n"))
        self.assertEqual(rows[0]["student_id"], "20261001")
        self.assertEqual(rows[0]["name"], "홍길동")


class ExpiresTest(unittest.TestCase):
    def test_future_date(self):
        dur = duration_from_expiry("2026-12-31")
        self.assertTrue(dur.endswith("s"))
        self.assertGreater(int(dur[:-1]), 0)

    def test_bad_format(self):
        with self.assertRaises(SystemExit):
            duration_from_expiry("31/12/2026")


if __name__ == "__main__":
    unittest.main()
