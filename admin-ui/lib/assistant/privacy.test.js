const test = require("node:test");
const assert = require("node:assert/strict");
const { NameMask, namesFrom } = require("./privacy");

test("별칭과 사용자 이름에서 사람 이름만 모은다", () => {
  const names = namesFrom({
    keys: [
      { key_alias: "20261001-홍길동" },
      { key_alias: "20261002-김철수-폐기" },
      { key_alias: "camp-0930-07" },
      { key_alias: "교사-시연" },
      { key_alias: null },
    ],
    users: [{ name: "이영희" }, { name: "student" }],
  });
  assert.deepEqual(names.sort(), ["김철수", "이영희", "홍길동"].sort());
});

test("가리고 되돌리면 원래 글이 된다", () => {
  const mask = NameMask.fromData({ keys: [{ key_alias: "20261001-홍길동" }, { key_alias: "20261002-김철수" }] });
  const text = "20261001-홍길동 키와 김철수 학생 키를 막아 주세요";
  const masked = mask.mask(text);
  assert.ok(!masked.includes("홍길동"));
  assert.ok(!masked.includes("김철수"));
  assert.match(masked, /20261001-학생\d{2}/);
  assert.equal(mask.unmask(masked), text);
});

test("긴 이름을 먼저 바꿔 겹치는 이름을 망가뜨리지 않는다", () => {
  const mask = new NameMask(["김철", "김철수"]);
  const masked = mask.mask("김철수와 김철");
  assert.equal(mask.unmask(masked), "김철수와 김철");
  assert.ok(!/김철/.test(masked));
});

test("객체 안의 글자도 가리고 되돌린다", () => {
  const mask = new NameMask(["홍길동"]);
  const obj = { target: { aliases: ["홍길동"], class: "3학년A반" }, n: 3, ok: true };
  const masked = mask.maskDeep(obj);
  assert.notEqual(masked.target.aliases[0], "홍길동");
  assert.equal(masked.n, 3);
  assert.deepEqual(mask.unmaskDeep(masked), obj);
});

test("이름이 없으면 그대로 둔다", () => {
  const mask = NameMask.none();
  assert.equal(mask.size, 0);
  assert.equal(mask.mask("홍길동"), "홍길동");
  assert.equal(mask.unmask("학생01"), "학생01");
});
