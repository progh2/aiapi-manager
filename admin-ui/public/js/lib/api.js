// 관리 API 호출. Firebase ID 토큰을 붙이고, 실패하면 status 가 달린 Error 를 던진다.
export function createApi(getToken) {
  async function api(path, { method = "GET", body, signal, headers: extra = {} } = {}) {
    const token = await getToken();
    const headers = { Authorization: `Bearer ${token}`, ...extra };
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
  }

  // text/event-stream 응답을 이벤트마다 onEvent(event, data) 로 넘긴다. POST 가 필요해 EventSource 대신 fetch 를 쓴다.
  api.stream = async function stream(path, body, onEvent, { signal } = {}) {
    const token = await getToken();
    let resp;
    try {
      resp = await fetch(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      const err = new Error("관리 서버에 연결하지 못했습니다. 네트워크를 확인하세요");
      err.status = 0;
      throw err;
    }
    if (!resp.ok || !resp.body) {
      let data = null;
      try { data = await resp.json(); } catch { data = null; }
      const err = new Error((data && data.error) || `요청 실패 (HTTP ${resp.status})`);
      err.status = resp.status;
      throw err;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        let event = "message";
        const lines = [];
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) lines.push(line.slice(5).trimStart());
        }
        if (!lines.length) continue;
        let data = lines.join("\n");
        try { data = JSON.parse(data); } catch { /* 글자 그대로 */ }
        onEvent(event, data);
      }
    }
  };

  return api;
}
