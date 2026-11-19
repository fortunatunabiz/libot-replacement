// LIBOT置き換え試作：紹介URL発行＋LINEログインひも付け＋Webhook受け口＋管理画面
// Cloudflare Workers でも Node（server.js経由）でも動く fetch ハンドラ。
//
// 環境変数（env）:
//   LINE_LOGIN_CHANNEL_ID     LINEログイン用チャネルのID（未設定ならモックモード）
//   LINE_LOGIN_CHANNEL_SECRET LINEログイン用チャネルのシークレット
//   LINE_CHANNEL_SECRET       Messaging APIチャネルのシークレット（Webhook署名検証用）
//   FRIEND_ADD_URL            ひも付け後に飛ばす友だち追加URL（既定: https://lin.ee/CgkOChp）
//   STORE                     KV互換ストア（get/put）。未設定ならメモリ内ストア。
//
// データ（すべてJSONで保存）:
//   referrers: [{code, name, created_at}]           紹介者と固定の個人コード
//   bindings:  [{user_id, display_name, referrer_code, referrer_name, added_at}]
//   events:    [{type, user_id, at, detail}]        Webhookで受けたイベントの記録

const DEFAULT_FRIEND_ADD_URL = "https://lin.ee/CgkOChp";

function memoryStore() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
  };
}
let fallbackStore = null;
function store(env) {
  if (env && env.STORE) return env.STORE;
  if (!fallbackStore) fallbackStore = memoryStore();
  return fallbackStore;
}

async function readJSON(env, key, fallback) {
  const raw = await store(env).get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}
async function writeJSON(env, key, value) {
  await store(env).put(key, JSON.stringify(value));
}

function html(body, status = 200) {
  return new Response(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>紹介URL管理（試作）</title>` +
    `<style>body{font-family:sans-serif;margin:24px;line-height:1.6}` +
    `table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 10px}` +
    `input,button{font-size:16px;padding:6px 10px}code{background:#f3f3f3;padding:2px 6px}</style>` +
    `</head><body>${body}</body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status, headers: { "content-type": "application/json; charset=utf-8" },
  });
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---- 紹介者まわり ----

async function issueReferrer(env, name) {
  const referrers = await readJSON(env, "referrers", []);
  const existing = referrers.find((r) => r.name === name);
  if (existing) return { referrer: existing, created: false }; // 個人ごとに固定：同じ名前なら同じURL
  const next = referrers.reduce((max, r) => Math.max(max, parseInt(r.code, 10) || 0), 0) + 1;
  const referrer = {
    code: String(next).padStart(5, "0"),
    name,
    memo: "",
    created_at: new Date().toISOString(),
  };
  referrers.push(referrer);
  await writeJSON(env, "referrers", referrers);
  return { referrer, created: true };
}

async function recordBinding(env, { user_id, display_name, referrer }) {
  const bindings = await readJSON(env, "bindings", []);
  const existing = bindings.find((b) => b.user_id === user_id);
  if (existing) return { binding: existing, created: false }; // 最初の紹介元を優先し、上書きしない
  const binding = {
    user_id,
    display_name: display_name || "",
    referrer_code: referrer.code,
    referrer_name: referrer.name,
    memo: "",
    status: "active", // active | blocked（ブロックされても消さず、状態として残す）
    blocked_at: "",
    added_at: new Date().toISOString(),
  };
  bindings.push(binding);
  await writeJSON(env, "bindings", bindings);
  return { binding, created: true };
}

// ---- Webhook署名検証（HMAC-SHA256） ----

async function verifySignature(secret, bodyText, signature) {
  if (!secret) return true; // 試作ローカル用：シークレット未設定なら検証をスキップ
  if (!signature) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(bodyText));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return expected === signature;
}

// ---- ルーティング ----

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    const base = url.origin;
    const path = url.pathname;
    const friendAddUrl = env.FRIEND_ADD_URL || DEFAULT_FRIEND_ADD_URL;
    const loginChannelId = env.LINE_LOGIN_CHANNEL_ID || "";
    const mockMode = !loginChannelId;

    // トップ
    if (path === "/" && request.method === "GET") {
      return html(`<h1>紹介URL管理（試作）</h1>
        <p><a href="/admin">管理画面を開く</a></p>
        <p>モード：${mockMode ? "モック（LINEログイン未接続）" : "本番（LINEログイン接続）"}</p>`);
    }

    // 管理画面：発行フォーム＋一覧
    if (path === "/admin" && request.method === "GET") {
      const referrers = await readJSON(env, "referrers", []);
      const bindings = await readJSON(env, "bindings", []);
      const countFor = (code) => bindings.filter((b) => b.referrer_code === code).length;
      const rows = referrers.map((r) =>
        `<tr><td>${esc(r.code)}</td><td>${esc(r.name)}</td>` +
        `<td><code>${esc(base)}/r/${esc(r.code)}</code></td><td>${countFor(r.code)}名</td>` +
        `<td>${esc(r.memo || "")}</td>` +
        `<td><form method="post" action="/admin/update-referrer">` +
        `<input type="hidden" name="code" value="${esc(r.code)}">` +
        `<input name="name" value="${esc(r.name)}" size="12">` +
        `<input name="memo" value="${esc(r.memo || "")}" size="16" placeholder="メモ">` +
        `<button type="submit">保存</button></form></td></tr>`
      ).join("");
      const brows = bindings.map((b) =>
        `<tr><td>${esc(b.display_name)}</td><td>${esc(b.user_id)}</td>` +
        `<td>${esc(b.referrer_name)}（${esc(b.referrer_code)}）</td><td>${esc(b.added_at)}</td>` +
        `<td>${b.status === "blocked" ? `ブロック済み（${esc(b.blocked_at)}）` : "友だち"}</td>` +
        `<td>${esc(b.memo || "")}</td>` +
        `<td><form method="post" action="/admin/update-binding">` +
        `<input type="hidden" name="user_id" value="${esc(b.user_id)}">` +
        `<input name="name" value="${esc(b.display_name)}" size="12">` +
        `<input name="memo" value="${esc(b.memo || "")}" size="16" placeholder="メモ">` +
        `<button type="submit">保存</button></form></td></tr>`
      ).join("");
      return html(`<h1>紹介URL管理（試作）</h1>
        <h2>紹介URLを発行する</h2>
        <form method="post" action="/admin/issue">
          <input name="name" placeholder="紹介者の名前" required>
          <button type="submit">紹介URLを発行</button>
        </form>
        <p>※同じ名前で再度発行しても、URLは変わりません（個人ごとに固定）。</p>
        <h2>紹介者一覧</h2>
        <table><tr><th>コード</th><th>名前</th><th>紹介URL</th><th>紹介人数</th><th>メモ</th><th>編集</th></tr>${rows || ""}</table>
        <h2>紹介の記録</h2>
        <table><tr><th>追加した人</th><th>ユーザーID</th><th>紹介元</th><th>追加日時</th><th>状態</th><th>メモ</th><th>編集</th></tr>${brows || ""}</table>
        <p>※名前とメモの変更はこのシステム内の表示・記録だけが変わります（その人のLINEの表示名自体は変わりません）。紹介URLやひも付けはIDで管理しているため、名前を変えても崩れません。</p>`);
    }

    // 発行（フォーム）
    if (path === "/admin/issue" && request.method === "POST") {
      const form = await request.formData();
      const name = String(form.get("name") || "").trim();
      if (!name) return html("<p>名前が空です。</p>", 400);
      await issueReferrer(env, name);
      return Response.redirect(`${base}/admin`, 303);
    }

    // 紹介者の編集（名前・メモ）：紹介の記録側の紹介元名も合わせて直す
    if (path === "/admin/update-referrer" && request.method === "POST") {
      const form = await request.formData();
      const code = String(form.get("code") || "");
      const name = String(form.get("name") || "").trim();
      const memo = String(form.get("memo") || "");
      if (!name) return html("<p>名前が空です。</p>", 400);
      const referrers = await readJSON(env, "referrers", []);
      const target = referrers.find((r) => r.code === code);
      if (!target) return html("<p>対象が見つかりません。</p>", 404);
      target.name = name;
      target.memo = memo;
      await writeJSON(env, "referrers", referrers);
      const bindings = await readJSON(env, "bindings", []);
      let touched = false;
      for (const b of bindings) {
        if (b.referrer_code === code) { b.referrer_name = name; touched = true; }
      }
      if (touched) await writeJSON(env, "bindings", bindings);
      return Response.redirect(`${base}/admin`, 303);
    }

    // 登録者の編集（名前・メモ）
    if (path === "/admin/update-binding" && request.method === "POST") {
      const form = await request.formData();
      const userId = String(form.get("user_id") || "");
      const name = String(form.get("name") || "").trim();
      const memo = String(form.get("memo") || "");
      if (!name) return html("<p>名前が空です。</p>", 400);
      const bindings = await readJSON(env, "bindings", []);
      const target = bindings.find((b) => b.user_id === userId);
      if (!target) return html("<p>対象が見つかりません。</p>", 404);
      target.display_name = name;
      target.memo = memo;
      await writeJSON(env, "bindings", bindings);
      return Response.redirect(`${base}/admin`, 303);
    }

    // 発行（API）
    if (path === "/api/issue" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const name = String(body.name || "").trim();
      if (!name) return json({ error: "name is required" }, 400);
      const { referrer, created } = await issueReferrer(env, name);
      return json({ code: referrer.code, name: referrer.name, url: `${base}/r/${referrer.code}`, created });
    }

    // 一覧（API）
    if (path === "/api/referrers" && request.method === "GET") {
      return json(await readJSON(env, "referrers", []));
    }
    if (path === "/api/bindings" && request.method === "GET") {
      return json(await readJSON(env, "bindings", []));
    }

    // 紹介URL：ひも付けの入口
    const refMatch = path.match(/^\/r\/(\d{5})$/);
    if (refMatch && request.method === "GET") {
      const referrers = await readJSON(env, "referrers", []);
      const referrer = referrers.find((r) => r.code === refMatch[1]);
      if (!referrer) return html("<p>この紹介URLは見つかりませんでした。</p>", 404);
      if (mockMode) {
        return Response.redirect(`${base}/mock-login?state=${referrer.code}`, 302);
      }
      const auth = new URL("https://access.line.me/oauth2/v2.1/authorize");
      auth.searchParams.set("response_type", "code");
      auth.searchParams.set("client_id", loginChannelId);
      auth.searchParams.set("redirect_uri", `${base}/callback`);
      auth.searchParams.set("state", referrer.code);
      auth.searchParams.set("scope", "profile openid");
      auth.searchParams.set("bot_prompt", "aggressive"); // 認可と同時に友だち追加も成立させる
      return Response.redirect(auth.toString(), 302);
    }

    // モック用ログイン画面（本番ではLINEの画面になる）
    if (path === "/mock-login" && request.method === "GET") {
      const state = url.searchParams.get("state") || "";
      return html(`<h1>（試作用）LINEログインの代わりの画面</h1>
        <p>本番ではここがLINEのログイン画面になり、押すだけで本人確認と友だち追加が進みます。</p>
        <form method="get" action="/callback">
          <input type="hidden" name="state" value="${esc(state)}">
          <input type="hidden" name="mock" value="1">
          <p>表示名：<input name="name" value="テスト花子" required></p>
          <p>ユーザーID：<input name="uid" value="U_test_hanako" required></p>
          <button type="submit">ログインして友だち追加する</button>
        </form>`);
    }

    // LINEログインの戻り先：ひも付けを記録して友だち追加へ
    if (path === "/callback" && request.method === "GET") {
      const state = url.searchParams.get("state") || "";
      const referrers = await readJSON(env, "referrers", []);
      const referrer = referrers.find((r) => r.code === state);
      if (!referrer) return html("<p>紹介元の情報が見つかりませんでした。</p>", 400);

      let userId = "", displayName = "";
      if (url.searchParams.get("mock") === "1") {
        userId = url.searchParams.get("uid") || "";
        displayName = url.searchParams.get("name") || "";
      } else {
        const code = url.searchParams.get("code") || "";
        const tokenRes = await fetch("https://api.line.me/oauth2/v2.1/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: `${base}/callback`,
            client_id: loginChannelId,
            client_secret: env.LINE_LOGIN_CHANNEL_SECRET || "",
          }),
        });
        const token = await tokenRes.json().catch(() => ({}));
        if (!token.access_token) return html("<p>LINEログインに失敗しました。</p>", 502);
        const profRes = await fetch("https://api.line.me/v2/profile", {
          headers: { authorization: `Bearer ${token.access_token}` },
        });
        const prof = await profRes.json().catch(() => ({}));
        userId = prof.userId || "";
        displayName = prof.displayName || "";
      }
      if (!userId) return html("<p>ユーザー情報を取得できませんでした。</p>", 502);
      await recordBinding(env, { user_id: userId, display_name: displayName, referrer });
      return Response.redirect(friendAddUrl, 302);
    }

    // Webhook受け口（Messaging API）
    if (path === "/webhook" && request.method === "POST") {
      const bodyText = await request.text();
      const ok = await verifySignature(
        env.LINE_CHANNEL_SECRET || "", bodyText, request.headers.get("x-line-signature")
      );
      if (!ok) return new Response("invalid signature", { status: 401 });
      const payload = JSON.parse(bodyText || "{}");
      const events = await readJSON(env, "events", []);
      const bindings = await readJSON(env, "bindings", []);
      let bindingsTouched = false;
      for (const ev of payload.events || []) {
        const uid = ev.source && ev.source.userId ? ev.source.userId : "";
        const now = new Date().toISOString();
        events.push({
          type: ev.type,
          user_id: uid,
          at: now,
          detail: ev.type === "message" && ev.message ? String(ev.message.text || "") : "",
        });
        // ブロック（unfollow）は消さずに状態として記録する。再追加（follow）で active に戻す
        const target = bindings.find((b) => b.user_id === uid);
        if (target && ev.type === "unfollow") {
          target.status = "blocked";
          target.blocked_at = now;
          bindingsTouched = true;
        } else if (target && ev.type === "follow" && target.status === "blocked") {
          target.status = "active";
          target.blocked_at = "";
          bindingsTouched = true;
        }
      }
      await writeJSON(env, "events", events);
      if (bindingsTouched) await writeJSON(env, "bindings", bindings);
      return new Response("OK");
    }
    if (path === "/api/events" && request.method === "GET") {
      return json(await readJSON(env, "events", []));
    }

    return new Response("not found", { status: 404 });
  },
};
