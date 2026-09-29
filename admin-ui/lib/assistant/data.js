// 대화 한 번 동안 쓰는 데이터 창구. 같은 목록을 여러 도구가 물어도 LiteLLM 에는 한 번만 묻는다.
function createDataView(src) {
  const memo = new Map();
  const once = (name, fn) => (...args) => {
    const id = `${name}:${JSON.stringify(args)}`;
    if (!memo.has(id)) memo.set(id, Promise.resolve().then(() => fn(...args)));
    return memo.get(id);
  };
  const missing = (name) => () => Promise.reject(new Error(`${name} 조회를 쓸 수 없습니다`));
  return {
    keys: once("keys", src.keys || missing("keys")),
    teams: once("teams", src.teams || missing("teams")),
    providers: once("providers", src.providers || missing("providers")),
    activity: once("activity", src.activity || missing("activity")),
    analytics: once("analytics", src.analytics || missing("analytics")),
    myKeys: once("myKeys", src.myKeys || missing("myKeys")),
    myActivity: once("myActivity", src.myActivity || missing("myActivity")),
    audit: src.audit || (() => []),
  };
}

module.exports = { createDataView };
