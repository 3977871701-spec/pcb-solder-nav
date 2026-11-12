// Optional Supabase transport. No library is required; board parsing remains local.
globalThis.Cloud = (() => {
  const STORE_KEY = "psn:cloud";
  const defaults = globalThis.PSN_CLOUD_CONFIG || {};
  function read() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; } }
  const saved = read();
  let config = { url: saved.config?.url || defaults.url || "", anonKey: saved.config?.anonKey || defaults.anonKey || "" };
  let session = saved.session || null;
  function persist() { try { localStorage.setItem(STORE_KEY, JSON.stringify({ config, session })); } catch (e) {} }
  function configured() { return !!(config.url && config.anonKey); }
  function state() { return { configured: configured(), url: config.url, anonKey: config.anonKey, email: session?.user?.email || "", userId: session?.user?.id || "", expiresAt: session?.expires_at || 0 }; }
  function setConfig(url, anonKey) {
    url = String(url || "").trim().replace(/\/+$/, "");
    const u = new URL(url);
    if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") throw new Error("云服务地址必须使用 HTTPS");
    if (!String(anonKey || "").trim()) throw new Error("请填写 Supabase anon key");
    if (url !== config.url || anonKey !== config.anonKey) session = null;
    config = { url, anonKey: String(anonKey).trim() }; persist();
  }
  async function call(path, options = {}, token) {
    if (!configured()) throw new Error("尚未配置云同步服务");
    const headers = { apikey: config.anonKey, "Content-Type": "application/json", ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(config.url + path, { ...options, headers });
    if (!r.ok) {
      let detail = {};
      try { detail = await r.json(); } catch (e) {}
      const err = new Error(detail.msg || detail.error_description || detail.error || `云服务返回 ${r.status}`);
      err.status = r.status; throw err;
    }
    if (r.status === 204) return null;
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  }
  function normalizeSession(s) {
    if (!s?.access_token) throw new Error("登录响应无效");
    session = { ...s, expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600) };
    persist(); return session;
  }
  async function refresh() {
    if (!session?.refresh_token) { session = null; persist(); throw new Error("登录已过期，请重新登录"); }
    try { return normalizeSession(await call("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: session.refresh_token }) })); }
    catch (e) { session = null; persist(); throw e; }
  }
  async function accessToken() {
    if (!session) throw new Error("请先登录云同步");
    if ((session.expires_at || 0) < Date.now() / 1000 + 30) await refresh();
    return session.access_token;
  }
  async function api(path, options = {}, retry = true) {
    try { return await call(path, options, await accessToken()); }
    catch (e) {
      if (e.status === 401 && retry && session?.refresh_token) { await refresh(); return api(path, options, false); }
      throw e;
    }
  }
  async function sendCode(email) {
    email = String(email || "").trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("请输入有效邮箱");
    await call("/auth/v1/otp", { method: "POST", body: JSON.stringify({ email, create_user: true }) });
  }
  async function signIn(email, token) {
    const s = await call("/auth/v1/verify", { method: "POST", body: JSON.stringify({ type: "email", email: String(email || "").trim(), token: String(token || "").trim() }) });
    return normalizeSession(s);
  }
  async function signOut() {
    try { if (session?.access_token) await call("/auth/v1/logout", { method: "POST" }, session.access_token); }
    finally { session = null; persist(); }
  }
  async function pull() { return api("/rest/v1/psn_boards?select=board_key,payload,updated_at,deleted"); }
  async function push(rows) {
    if (!rows.length) return;
    const s = session?.user?.id ? session : await (async () => { await accessToken(); return session; })();
    const body = rows.map(r => ({ ...r, user_id: s.user.id }));
    await api("/rest/v1/psn_boards?on_conflict=user_id,board_key", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(body) });
  }
  return { state, setConfig, sendCode, signIn, signOut, pull, push };
})();
