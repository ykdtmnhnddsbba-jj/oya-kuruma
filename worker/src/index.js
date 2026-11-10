// 車、ちょっと借ります: API (Cloudflare Workers + KV)
// 利用者は2人だけ: son(借りる人) と parent(親)。ログイン不要で、専用リンクのトークンで本人確認する。

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
};
const JSON_H = { 'content-type': 'application/json; charset=utf-8', ...CORS };
const DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const enc = new TextEncoder();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: JSON_H });

function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = enc.encode(a);
  const y = enc.encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}

function roleOf(req, env) {
  const m = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  if (safeEq(m[1], env.TOKEN_SON)) return 'son';
  if (safeEq(m[1], env.TOKEN_PARENT)) return 'parent';
  return null;
}

const nameOf = (env, role) =>
  role === 'son' ? env.NAME_SON || 'たろう' : env.NAME_PARENT || '母';
// 呼び方: 子は「たろうさん」、親は「母」(敬称なし)
const callName = (env, role) => (role === 'son' ? `${nameOf(env, 'son')}さん` : nameOf(env, 'parent'));

// ---------- データ ----------
async function load(env) {
  const s = await env.KV.get('events');
  return s ? JSON.parse(s) : [];
}
async function save(env, events) {
  const cutoff = new Date(Date.now() - 90 * 86400000 + 9 * 3600000).toISOString().slice(0, 16);
  const kept = events.filter((e) => e.end >= cutoff).slice(-500);
  await env.KV.put('events', JSON.stringify(kept));
}

const text = (s, max) => String(s ?? '').trim().slice(0, max);

function checkTimes(start, end) {
  if (!DT.test(start || '') || !DT.test(end || '')) throw new HttpError(400, '日時の形式が正しくありません');
  if (isNaN(new Date(start + ':00Z')) || isNaN(new Date(end + ':00Z'))) throw new HttpError(400, '日時が正しくありません');
  if (end <= start) throw new HttpError(400, '終了は開始より後にしてください');
}

const overlap = (a, b) => a.start < b.end && b.start < a.end;
// 下書きは、同じ人の予定にだけ影響する(親から見えないため)
const blocks = (e, cand) => e.status === 'active' || e.status === 'busy' || (e.status === 'draft' && e.by === cand.by);

function checkConflict(events, cand, selfId) {
  const hit = events.find((e) => e.id !== selfId && blocks(e, cand) && overlap(e, cand));
  if (hit) {
    const what = hit.status === 'busy' ? `親の予定「${hit.place}」` : hit.status === 'draft' ? '下書きの予定' : 'ほかの予定';
    throw new HttpError(409, `${what}(${range(hit)})と時間が重なっています`);
  }
}

const WD = ['日', '月', '火', '水', '木', '金', '土'];
function fmtDay(s) {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return `${m}/${d}(${WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]})`;
}
function fmt(s) {
  return `${fmtDay(s)} ${s.slice(11, 16)}`;
}
function range(e) {
  return e.start.slice(0, 10) === e.end.slice(0, 10)
    ? `${fmtDay(e.start)} ${e.start.slice(11, 16)}〜${e.end.slice(11, 16)}`
    : `${fmt(e.start)}〜${fmt(e.end)}`;
}

const REPEAT_LABEL = { weekly: '毎週', biweekly: '隔週', monthly: '毎月' };
const MAX_REPEAT = 60;
// くり返しを1回ずつの [start, end] に展開する
function expandRepeat(start, end, rep) {
  if (!REPEAT_LABEL[rep.type]) throw new HttpError(400, 'くり返しの種類が正しくありません');
  const until = String(rep.until || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new HttpError(400, 'くり返しの終了日を入れてください');
  const sd = start.slice(0, 10);
  if (until < sd) throw new HttpError(400, '終了日は開始日より後にしてください');
  const ymd = (d) => [+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)];
  const [y, m, d] = ymd(sd);
  const dayMs = 86400000;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const diff = Math.round((Date.UTC(...ymd(end.slice(0, 10))) - Date.UTC(y, m, d)) / dayMs);
  const out = [];
  for (let k = 0; k < 130; k++) {
    let ms;
    if (rep.type === 'monthly') {
      ms = Date.UTC(y, m + k, d);
      if (new Date(ms).getUTCDate() !== d) continue; // 31日などが無い月は飛ばす
    } else {
      ms = Date.UTC(y, m, d) + k * 7 * (rep.type === 'biweekly' ? 2 : 1) * dayMs;
    }
    if (iso(ms) > until) break;
    out.push([iso(ms) + start.slice(10), iso(ms + diff * dayMs) + end.slice(10)]);
    if (out.length > MAX_REPEAT) throw new HttpError(400, `くり返しは最大${MAX_REPEAT}回までです。終了日を早めてください`);
  }
  return out;
}

// ---------- LINE ----------
async function linePush(env, role, body) {
  const uid = await env.KV.get('line:' + role);
  if (!uid || !env.LINE_CHANNEL_TOKEN) return false;
  const tok = role === 'son' ? env.TOKEN_SON : env.TOKEN_PARENT;
  const link = env.SITE_URL ? `\n\n${env.SITE_URL}#t=${tok}` : '';
  const r = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.LINE_CHANNEL_TOKEN}` },
    body: JSON.stringify({ to: uid, messages: [{ type: 'text', text: body + link }] }),
  });
  return r.ok;
}
async function lineReply(env, replyToken, body) {
  if (!env.LINE_CHANNEL_TOKEN) return;
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.LINE_CHANNEL_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: body }] }),
  });
}
async function verifySignature(env, raw, sig) {
  if (!env.LINE_CHANNEL_SECRET || !sig) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(env.LINE_CHANNEL_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(raw)));
  let bin = '';
  for (const b of mac) bin += String.fromCharCode(b);
  return safeEq(btoa(bin), sig);
}

async function handleWebhook(req, env, ctx) {
  const raw = await req.text();
  if (!(await verifySignature(env, raw, req.headers.get('x-line-signature')))) {
    return new Response('bad signature', { status: 401 });
  }
  const body = JSON.parse(raw);
  for (const ev of body.events || []) {
    const uid = ev.source?.userId;
    if (ev.type === 'follow') {
      ctx.waitUntil(lineReply(env, ev.replyToken, '友だち追加ありがとうございます。サイトの「LINE通知の設定」に出る6桁の数字を、このトークに「連携 123456」の形で送ってください。'));
    } else if (ev.type === 'message' && ev.message?.type === 'text' && uid) {
      const m = ev.message.text.match(/^\s*(?:連携|登録)\s*([0-9０-９]{6})\s*$/);
      if (m) {
        const code = m[1].replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
        const role = await env.KV.get('code:' + code);
        if (role) {
          await env.KV.put('line:' + role, uid);
          await env.KV.delete('code:' + code);
          ctx.waitUntil(lineReply(env, ev.replyToken, `連携できました(${callName(env, role)}用)。これから車の予定の通知がここに届きます。`));
        } else {
          ctx.waitUntil(lineReply(env, ev.replyToken, '数字が違うか、期限切れです。サイトでもう一度数字を出してください。'));
        }
      } else {
        ctx.waitUntil(lineReply(env, ev.replyToken, 'サイトの「LINE通知の設定」に出る6桁の数字を「連携 123456」の形で送ってください。'));
      }
    }
  }
  return json({ ok: true });
}

// ---------- ルーティング ----------
async function route(req, env, ctx) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method;

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (path === '/' && method === 'GET') return json({ ok: true, app: 'oya-kuruma' });
  if (path === '/api/line/webhook' && method === 'POST') return handleWebhook(req, env, ctx);

  const me = roleOf(req, env);
  if (!me) throw new HttpError(401, 'このリンクは無効です');
  const other = me === 'son' ? 'parent' : 'son';
  const notify = (role, body) => ctx.waitUntil(linePush(env, role, body).catch(() => {}));
  const readBody = async () => {
    try {
      return await req.json();
    } catch {
      throw new HttpError(400, '送信内容が読み取れません');
    }
  };

  if (path === '/api/events' && method === 'GET') {
    return json({
      me,
      names: { son: nameOf(env, 'son'), parent: nameOf(env, 'parent') },
      events: (await load(env)).filter((e) => me === 'son' || e.status !== 'draft'),
      lineLinked: !!(await env.KV.get('line:' + me)),
    });
  }

  if (path === '/api/events' && method === 'POST') {
    const b = await readBody();
    checkTimes(b.start, b.end);
    const events = await load(env);
    const place = text(b.place, 60);
    if (!place) throw new HttpError(400, me === 'son' ? '行き先・用途を入れてください' : '予定の内容を入れてください');
    const now = new Date().toISOString();
    const rep = b.repeat && b.repeat.type ? b.repeat : null;
    const slots = rep ? expandRepeat(b.start, b.end, rep) : [[b.start, b.end]];
    const seriesId = rep ? crypto.randomUUID() : null;
    const created = [];
    const skipped = [];
    for (const [st, en] of slots) {
      const ev = {
        id: crypto.randomUUID(),
        kind: me === 'son' ? 'request' : 'busy',
        by: me,
        place,
        note: text(b.note, 300),
        start: st,
        end: en,
        status: me === 'son' ? 'draft' : 'busy',
        comments: [],
        createdAt: now,
        updatedAt: now,
        ...(seriesId ? { seriesId, repeat: rep.type } : {}),
      };
      try {
        checkConflict(events, ev, null);
      } catch (e) {
        if (e instanceof HttpError && e.status === 409) {
          skipped.push({ start: st, reason: e.message });
          continue;
        }
        throw e;
      }
      events.push(ev);
      created.push(ev);
    }
    if (!created.length) throw new HttpError(409, skipped[0]?.reason || '時間が重なっています');
    await save(env, events);
    const first = created[0];
    const last = created[created.length - 1];
    const skipText = skipped.length ? `\n重なりのため除いた日: ${skipped.map((x) => fmtDay(x.start)).join('、')}` : '';
    const whenText = rep
      ? `${REPEAT_LABEL[rep.type]} ${first.start.slice(11, 16)}〜${first.end.slice(11, 16)} 計${created.length}回\n${fmtDay(first.start)} 〜 ${fmtDay(last.start)}`
      : range(first);
    const tag = rep ? '(くり返し)' : '';
    if (me === 'parent') {
      notify('son', `【親の予定${tag}】\n${callName(env, 'parent')}が車を使う予定を入れました。\n${whenText}\n内容: ${first.place}${skipText}`);
    }
    return json({ event: first, events: created, skipped }, 201);
  }

  const m = path.match(/^\/api\/events\/([\w-]+)(?:\/(decision|comments))?$/);
  if (m) {
    const [, id, sub] = m;
    const events = await load(env);
    const idx = events.findIndex((e) => e.id === id);
    if (idx < 0 || (me === 'parent' && events[idx].status === 'draft')) throw new HttpError(404, '予定が見つかりません(削除された可能性があります)');
    const ev = events[idx];
    const now = new Date().toISOString();

    // 否認 / 否認の取り消し(親のみ)
    if (sub === 'decision' && method === 'POST') {
      if (me !== 'parent') throw new HttpError(403, '否認できるのは親だけです');
      if (ev.kind !== 'request') throw new HttpError(400, '申請ではありません');
      const b = await readBody();
      if (!['decline', 'restore'].includes(b.action)) throw new HttpError(400, '操作が正しくありません');
      const msg = text(b.comment, 500);
      if (b.action === 'restore') checkConflict(events, ev, ev.id);
      ev.status = b.action === 'decline' ? 'declined' : 'active';
      ev.decidedAt = now;
      ev.updatedAt = now;
      if (msg) ev.comments.push({ by: me, text: msg, at: now });
      events[idx] = ev;
      await save(env, events);
      notify('son', `${ev.status === 'declined' ? '【否認されました】\n今回は車を使えません。' : '【否認を取り消しました】\nこの予定は有効に戻りました。'}\n${range(ev)}\n行き先・用途: ${ev.place}${msg ? '\n\nコメント: ' + msg : ''}`);
      return json({ event: ev });
    }

    // コメント(両者)
    if (sub === 'comments' && method === 'POST') {
      if (ev.kind !== 'request') throw new HttpError(400, 'コメントできるのは申請だけです');
      if (ev.status === 'draft') throw new HttpError(400, '下書きにはコメントできません。先に母へ送ってください');
      const b = await readBody();
      const msg = text(b.text, 500);
      if (!msg) throw new HttpError(400, 'コメントを入れてください');
      ev.comments.push({ by: me, text: msg, at: now });
      ev.updatedAt = now;
      events[idx] = ev;
      await save(env, events);
      notify(other, `【コメント】${callName(env, me)}より\n${range(ev)}(${ev.place})\n\n${msg}`);
      return json({ event: ev });
    }

    // 変更
    if (!sub && method === 'PATCH') {
      if (ev.by !== me) throw new HttpError(403, '自分の予定だけ変更できます');
      const b = await readBody();
      const next = { ...ev, start: b.start ?? ev.start, end: b.end ?? ev.end, place: text(b.place ?? ev.place, 60), note: text(b.note ?? ev.note, 300) };
      checkTimes(next.start, next.end);
      if (!next.place) throw new HttpError(400, '内容を入れてください');
      const timeChanged = next.start !== ev.start || next.end !== ev.end;
      checkConflict(events, next, ev.id);
      if (ev.kind === 'request' && ev.status === 'declined' && (timeChanged || next.place !== ev.place)) {
        next.status = 'active';
        delete next.decidedAt;
      }
      next.updatedAt = now;
      events[idx] = next;
      await save(env, events);
      if (next.status === 'draft') {
        // 下書きの変更は通知しない
      } else if (next.kind === 'request') {
        notify('parent', `【申請を変更しました】\n${nameOf(env, 'son')}さんの申請が変わりました。\n${range(next)}\n行き先・用途: ${next.place}${next.note ? '\nメモ: ' + next.note : ''}`);
      } else {
        notify('son', `【親の予定を変更】\n${range(next)}\n内容: ${next.place}`);
      }
      return json({ event: next });
    }

    // 削除・取り消し(scope=following: 同じくり返しの、この回以降をまとめて)
    if (!sub && method === 'DELETE') {
      if (ev.by !== me) throw new HttpError(403, '自分の予定だけ消せます');
      const following = url.searchParams.get('scope') === 'following' && ev.seriesId;
      const removed = following ? events.filter((e) => e.seriesId === ev.seriesId && e.by === me && e.start >= ev.start) : [ev];
      const ids = new Set(removed.map((e) => e.id));
      await save(env, events.filter((e) => !ids.has(e.id)));
      const sentRemoved = removed.filter((e) => e.status !== 'draft');
      if (removed.length > 1 && sentRemoved.length > 1) {
        notify(other, `【くり返しの予定を取り消し】\n${callName(env, me)}が ${fmtDay(ev.start)} 以降の ${sentRemoved.length}回分(${ev.place})を取り消しました。`);
      } else if (ev.kind === 'request' && ev.status === 'active' && removed.length === 1) {
        notify('parent', `【申請の取り消し】\n${nameOf(env, 'son')}さんが取り消しました。\n${range(ev)}(${ev.place})`);
      } else if (ev.kind === 'busy') {
        notify('son', `【親の予定を削除】\n${range(ev)}(${ev.place})の予定がなくなりました。`);
      }
      return json({ ok: true, removed: removed.length });
    }
  }

  // 下書きをまとめて母へ送る(LINEは1通)
  if (path === '/api/send' && method === 'POST') {
    if (me !== 'son') throw new HttpError(403, '送れるのは申請する側だけです');
    const events = await load(env);
    const drafts = events.filter((e) => e.by === 'son' && e.kind === 'request' && e.status === 'draft').sort((a, b) => (a.start < b.start ? -1 : 1));
    if (!drafts.length) throw new HttpError(400, '送る下書きがありません');
    const now = new Date().toISOString();
    const sent = [];
    const skipped = [];
    for (const ev of drafts) {
      const hit = events.find((x) => x.id !== ev.id && (x.status === 'active' || x.status === 'busy') && overlap(x, ev));
      if (hit) {
        skipped.push({ id: ev.id, start: ev.start, reason: `${hit.status === 'busy' ? `親の予定「${hit.place}」` : 'ほかの予定'}(${range(hit)})と重なっています` });
        continue;
      }
      ev.status = 'active';
      ev.sentAt = now;
      ev.updatedAt = now;
      sent.push(ev);
    }
    if (!sent.length) throw new HttpError(409, skipped[0].reason);
    await save(env, events);
    const lines = [];
    const groups = new Map();
    for (const ev of sent) {
      if (ev.seriesId) {
        if (!groups.has(ev.seriesId)) {
          const g = { list: [] };
          groups.set(ev.seriesId, g);
          lines.push(g);
        }
        groups.get(ev.seriesId).list.push(ev);
      } else {
        lines.push(`${range(ev)} ${ev.place}${ev.note ? '(' + ev.note + ')' : ''}`);
      }
    }
    const textLines = lines.map((l) => {
      if (typeof l === 'string') return l;
      const f = l.list[0];
      const e2 = l.list[l.list.length - 1];
      return `${REPEAT_LABEL[f.repeat] || 'くり返し'} ${f.start.slice(11, 16)}〜${f.end.slice(11, 16)} ${f.place}(${fmtDay(f.start)}〜${fmtDay(e2.start)} 計${l.list.length}回)`;
    });
    const shown = textLines.slice(0, 12).map((t) => '・' + t);
    if (textLines.length > 12) shown.push(`ほか ${textLines.length - 12}件`);
    const skipText = skipped.length ? `\n\n重なりのため送らなかった分: ${skipped.map((x) => fmtDay(x.start)).join('、')}` : '';
    ctx.waitUntil(linePush(env, 'parent', `【車を借りたい】\n${nameOf(env, 'son')}さんから ${sent.length}件の申請です。\n\n${shown.join('\n')}${skipText}\n\n問題があれば、サイトで「否認」かコメントをお願いします。`).catch(() => {}));
    return json({ sent: sent.length, skipped });
  }

  // LINE連携
  if (path === '/api/line/code' && method === 'POST') {
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
    await env.KV.put('code:' + code, me, { expirationTtl: 600 });
    return json({ code, expiresInMinutes: 10 });
  }
  if (path === '/api/line/test' && method === 'POST') {
    const ok = await linePush(env, me, '【テスト】通知はここに届きます。');
    return json({ ok });
  }

  throw new HttpError(404, 'not found');
}

export default {
  async fetch(req, env, ctx) {
    try {
      return await route(req, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'サーバーでエラーが起きました' }, 500);
    }
  },
};
