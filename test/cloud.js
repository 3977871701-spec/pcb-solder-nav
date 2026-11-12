// Supabase transport contract test with an in-memory API; no network or credentials needed.
const assert = require("assert");
const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
const calls = [];
let refreshed = false, unauthorized = false;
globalThis.fetch = async (url, options = {}) => {
  const call = { url, options, body: options.body ? JSON.parse(options.body) : null };
  calls.push(call);
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  if (url.endsWith("/auth/v1/otp")) { assert.equal(call.body.create_user, true); return json({}); }
  if (url.endsWith("/auth/v1/verify")) return json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, user: { id: "user-1", email: call.body.email } });
  if (url.endsWith("/auth/v1/logout")) return json({});
  if (url.endsWith("/auth/v1/token?grant_type=refresh_token")) { refreshed = true; return json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, user: { id: "user-1", email: "a@example.com" } }); }
  if (url.includes("/rest/v1/psn_boards")) {
    if (unauthorized) { unauthorized = false; return json({ msg: "expired" }, 401); }
    assert.equal(options.headers.apikey, "anon-key");
    assert.equal(options.headers.Authorization, `Bearer ${refreshed ? "new-access" : "access"}`);
    if (options.method === "POST") assert.equal(call.body[0].user_id, "user-1");
    return json(options.method === "POST" ? null : [{ board_key: "board-a", payload: null, updated_at: "2026-01-01T00:00:00Z", deleted: true }]);
  }
  throw new Error("Unexpected URL: " + url);
};

(async () => {
  require("../src/cloud.js");
  Cloud.setConfig("https://example.supabase.co/", "anon-key");
  await Cloud.sendCode("a@example.com");
  await Cloud.signIn("a@example.com", "123456");
  assert.equal(Cloud.state().email, "a@example.com");
  const rows = await Cloud.pull();
  assert.equal(rows[0].board_key, "board-a");
  await Cloud.push([{ board_key: "board-a", payload: { board: { key: "board-a" } }, updated_at: "2026-01-01T00:00:00Z", deleted: false }]);
  await Cloud.signOut();
  assert.equal(Cloud.state().email, "");

  await Cloud.signIn("a@example.com", "123456");
  unauthorized = true;
  await Cloud.pull();
  assert.equal(refreshed, true);
  console.log(`PASS cloud transport: ${calls.length} API calls, auth, pull/push, logout and token refresh`);
})().catch(e => { console.error(e); process.exitCode = 1; });
