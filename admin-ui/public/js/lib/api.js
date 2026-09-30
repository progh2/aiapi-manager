// 관리 API 호출. Firebase ID 토큰을 붙이고, 실패하면 status 가 달린 Error 를 던진다.
export function createApi(getToken) {
  return async function api(path, { method = "GET", body, signal } = {}) {
    const token = await getToken();
    const headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let resp;
    try {
      resp = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      const err = new Error("관리 서버에 연결하지 못했습니다. 네트워크를 확인하세요");
      err.status = 0;
      throw err;
    }
    let data = null;
    try { data = await resp.json(); } catch { data = null; }
    if (!resp.ok) {
      const err = new Error((data && data.error) || `요청 실패 (HTTP ${resp.status})`);
      err.status = resp.status;
      throw err;
    }
    return data;
  };
}
