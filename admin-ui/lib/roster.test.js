const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  aliasFor,
  parseRoster,
  normalizeStudentList,
  durationFromExpiryDate,
} = require("./roster");

describe("aliasFor", () => {
  it("학번-이름 별칭을 만든다", () => {
    assert.equal(aliasFor("20261001", "홍길동"), "20261001-홍길동");
  });
  it("한쪽만 있으면 그것만 쓴다", () => {
    assert.equal(aliasFor("20261001", ""), "20261001");
    assert.equal(aliasFor("", "홍길동"), "홍길동");
  });
});

describe("parseRoster", () => {
  it("CLI 헤더 name,student_id 를 읽는다", () => {
    const { students, errors } = parseRoster("name,student_id\n홍길동,20261001\n김철수,20261002");
    assert.equal(errors.length, 0);
    assert.deepEqual(students, [
      { student_id: "20261001", name: "홍길동", alias: "20261001-홍길동" },
      { student_id: "20261002", name: "김철수", alias: "20261002-김철수" },
    ]);
  });

  it("UI 헤더 학번,이름 을 읽는다", () => {
    const { students, errors } = parseRoster("학번,이름\n20261001,홍길동\n20261002,이영희");
    assert.equal(errors.length, 0);
    assert.equal(students[0].alias, "20261001-홍길동");
    assert.equal(students[1].name, "이영희");
  });

  it("헤더 없이 학번,이름 붙여넣기를 읽는다", () => {
    const { students, errors } = parseRoster("20261001,홍길동\n20261002\t김철수");
    assert.equal(errors.length, 0);
    assert.equal(students.length, 2);
    assert.equal(students[1].alias, "20261002-김철수");
  });

  it("헤더 없이 이름,학번 도 학번이 숫자면 맞춘다", () => {
    const { students } = parseRoster("홍길동,20261001");
    assert.equal(students[0].alias, "20261001-홍길동");
    assert.equal(students[0].student_id, "20261001");
  });

  it("BOM·빈 줄을 무시한다", () => {
    const { students, errors } = parseRoster("\uFEFFname,student_id\n\n홍길동,20261001\n\n");
    assert.equal(errors.length, 0);
    assert.equal(students.length, 1);
  });

  it("빈 칸만 있는 줄은 오류로 남긴다", () => {
    const { students, errors } = parseRoster("학번,이름\n20261001,홍길동\n,");
    assert.equal(students.length, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0].error, /학번 또는 이름/);
  });
});

describe("normalizeStudentList", () => {
  it("기존 {alias} 요청을 그대로 받는다", () => {
    const { students, errors } = normalizeStudentList([{ alias: "20261001-홍길동" }]);
    assert.equal(errors.length, 0);
    assert.equal(students[0].alias, "20261001-홍길동");
  });

  it("student_id+name 으로 별칭을 만든다", () => {
    const { students } = normalizeStudentList([{ student_id: "20261001", name: "홍길동" }]);
    assert.equal(students[0].alias, "20261001-홍길동");
  });
});

describe("durationFromExpiryDate", () => {
  it("그날 끝까지의 초를 LiteLLM duration으로 보낸다", () => {
    const now = new Date(2026, 8, 15, 15, 0, 0); // 2026-09-15 15:00
    const dur = durationFromExpiryDate("2026-12-31", now);
    assert.match(dur, /^\d+s$/);
    const end = new Date(2026, 11, 31, 23, 59, 59, 999);
    const expected = Math.ceil((end - now) / 1000);
    assert.equal(dur, `${expected}s`);
  });

  it("지난 날짜는 거절한다", () => {
    const now = new Date(2026, 8, 15, 15, 0, 0);
    assert.throws(
      () => durationFromExpiryDate("2026-09-14", now),
      (e) => e.status === 400 && /오늘 이후/.test(e.message)
    );
  });

  it("형식이 아니면 거절한다", () => {
    assert.throws(() => durationFromExpiryDate("31/12/2026"), /YYYY-MM-DD/);
  });
});
