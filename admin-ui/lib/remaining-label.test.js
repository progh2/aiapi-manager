const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let hasRemaining, remainingPhrase, remainingTipLine, rankValueText, money;

before(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, "../public/remaining-label.js")).href);
  hasRemaining = mod.hasRemaining;
  remainingPhrase = mod.remainingPhrase;
  remainingTipLine = mod.remainingTipLine;
  rankValueText = mod.rankValueText;
  money = mod.money;
});

describe("hasRemaining", () => {
  it("remaining이 있으면 true", () => {
    assert.equal(hasRemaining({ remaining: 1.2 }), true);
    assert.equal(hasRemaining({ remaining: 0 }), true);
    assert.equal(hasRemaining({ remaining: -0.5 }), true);
  });
  it("구 API·무제한 키는 false", () => {
    assert.equal(hasRemaining({ remaining: null }), false);
    assert.equal(hasRemaining({}), false);
    assert.equal(hasRemaining({ remaining: Number.NaN }), false);
    assert.equal(hasRemaining(null), false);
  });
});

describe("remainingPhrase / remainingTipLine", () => {
  it("양수 잔여", () => {
    assert.equal(remainingPhrase(0.8), `잔여 ${money(0.8)}`);
    assert.equal(remainingTipLine(0.8), `잔여 ${money(0.8)}`);
  });
  it("음수면 초과로 표시", () => {
    assert.equal(remainingPhrase(-0.4), `초과 ${money(0.4)}`);
    assert.equal(remainingTipLine(-0.4), `잔여 -${money(0.4)} (초과)`);
  });
});

describe("rankValueText", () => {
  const withRem = { spend: 1.2, budget: 2, remaining: 0.8 };
  const over = { spend: 2.4, budget: 2, remaining: -0.4 };
  const legacy = { spend: 1.2, budget: 2 };
  const unlimited = { spend: 0.55, remaining: null };

  it("remaining이 있으면 잔여를 앞에 두고 지출/예산을 붙인다", () => {
    assert.equal(rankValueText(withRem), `잔여 ${money(0.8)} · ${money(1.2)} / ${money(2)}`);
  });
  it("좁은 화면은 잔여만", () => {
    assert.equal(rankValueText(withRem, { compact: true }), `잔여 ${money(0.8)}`);
  });
  it("음수 remaining은 초과 문구", () => {
    assert.equal(rankValueText(over, { compact: true }), `초과 ${money(0.4)}`);
  });
  it("remaining이 없으면 예전 spend/budget + 초과", () => {
    assert.equal(rankValueText(legacy), `${money(1.2)} / ${money(2)}`);
    assert.equal(rankValueText({ spend: 2.4, budget: 2 }), `${money(2.4)} / ${money(2)} 초과`);
  });
  it("무제한 키는 지출만", () => {
    assert.equal(rankValueText(unlimited), money(0.55));
  });
});
