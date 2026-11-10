import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from './src/index.js';

const store = new Map();
const KV = {
  get: async (k) => store.get(k) ?? null,
  put: async (k, v) => void store.set(k, v),
  delete: async (k) => void store.delete(k),
};
const env = { KV, TOKEN_SON: 'son-token', TOKEN_PARENT: 'parent-token', LINE_CHANNEL_TOKEN: 'tok', LINE_CHANNEL_SECRET: 'sec', SITE_URL: 'https://x.example/' };

const pushes = [];
globalThis.fetch = async (url, init) => {
  pushes.push({ url, body: JSON.parse(init.body) });
  return new Response('{}', { status: 200 });
};
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };

async function call(method, path, token, body) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await worker.fetch(new Request('https://w.example' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  await Promise.all(pending.splice(0));
  return { status: res.status, data: await res.json() };
}
const S = 'son-token', P = 'parent-token';

// 認証
assert.equal((await call('GET', '/api/events', null)).status, 401);
assert.equal((await call('GET', '/api/events', 'bad')).status, 401);
assert.equal((await call('GET', '/api/events', S)).data.me, 'son');
assert.equal((await call('GET', '/api/events', P)).data.me, 'parent');

// LINE連携(コード→webhook)
const code = (await call('POST', '/api/line/code', S)).data.code;
assert.match(code, /^\d{6}$/);
async function webhook(events, sig) {
  const raw = JSON.stringify({ events });
  const s = sig ?? createHmac('sha256', 'sec').update(raw).digest('base64');
  const res = await worker.fetch(new Request('https://w.example/api/line/webhook', { method: 'POST', headers: { 'x-line-signature': s }, body: raw }), env, ctx);
  await Promise.all(pending.splice(0));
  return res.status;
}
assert.equal(await webhook([], 'wrong'), 401);
assert.equal(await webhook([{ type: 'message', replyToken: 'r', source: { userId: 'U_SON' }, message: { type: 'text', text: `連携 ${code}` } }]), 200);
assert.equal(store.get('line:son'), 'U_SON');
const code2 = (await call('POST', '/api/line/code', P)).data.code;
await webhook([{ type: 'message', replyToken: 'r', source: { userId: 'U_PAR' }, message: { type: 'text', text: `連携　${code2}`.replace('　', ' ') } }]);
assert.equal(store.get('line:parent'), 'U_PAR');
assert.equal((await call('GET', '/api/events', S)).data.lineLinked, true);

// ---- 下書き → まとめて送信 ----
pushes.length = 0;
let r = await call('POST', '/api/events', S, { start: '2026-11-15T10:00', end: '2026-11-15T15:00', place: '買い物', note: '' });
assert.equal(r.status, 201);
assert.equal(r.data.event.status, 'draft');
assert.equal(pushes.length, 0); // 下書きではLINEを送らない
const id = r.data.event.id;
assert.equal((await call('GET', '/api/events', P)).data.events.length, 0); // 親には見えない
assert.equal((await call('GET', '/api/events', S)).data.events.length, 1);
assert.equal((await call('POST', `/api/events/${id}/decision`, P, { action: 'decline' })).status, 404);
assert.equal((await call('POST', `/api/events/${id}/comments`, S, { text: 'x' })).status, 400);
// 下書き同士は重ならない
assert.equal((await call('POST', '/api/events', S, { start: '2026-11-15T14:00', end: '2026-11-15T16:00', place: 'a' })).status, 409);
// 下書きの変更・削除は通知しない
r = await call('POST', '/api/events', S, { start: '2026-11-16T10:00', end: '2026-11-16T11:00', place: 'tmp' });
await call('PATCH', `/api/events/${r.data.event.id}`, S, { place: 'tmp2' });
await call('DELETE', `/api/events/${r.data.event.id}`, S);
assert.equal(pushes.length, 0);
// 入力チェック
assert.equal((await call('POST', '/api/events', S, { start: '2026-11-15T10:00', end: '2026-11-15T09:00', place: 'x' })).status, 400);
assert.equal((await call('POST', '/api/events', S, { start: '2026-11-15T10:00', end: '2026-11-15T11:00', place: '' })).status, 400);
// 親は送れない / 送ると1通だけ届く
assert.equal((await call('POST', '/api/send', P)).status, 403);
r = await call('POST', '/api/send', S);
assert.equal(r.data.sent, 1);
assert.equal(pushes.length, 1);
assert.equal(pushes.at(-1).body.to, 'U_PAR');
assert.match(pushes.at(-1).body.messages[0].text, /買い物/);
assert.match(pushes.at(-1).body.messages[0].text, /parent-token/);
assert.equal((await call('POST', '/api/send', S)).status, 400); // 送る下書きなし
assert.equal((await call('GET', '/api/events', P)).data.events[0].status, 'active'); // 親に見える

// 子は否認できない
assert.equal((await call('POST', `/api/events/${id}/decision`, S, { action: 'decline' })).status, 403);

// コメントは即時通知
pushes.length = 0;
await call('POST', `/api/events/${id}/comments`, P, { text: '何時に帰る?' });
assert.equal(pushes.at(-1).body.to, 'U_SON');
await call('POST', `/api/events/${id}/comments`, S, { text: '15時です' });
assert.equal(pushes.at(-1).body.to, 'U_PAR');

// 送信済みと重なる申請は不可、隣接はOK(下書き)
assert.equal((await call('POST', '/api/events', S, { start: '2026-11-15T14:00', end: '2026-11-15T16:00', place: 'a' })).status, 409);
assert.equal((await call('POST', '/api/events', S, { start: '2026-11-15T15:00', end: '2026-11-15T16:00', place: 'a' })).status, 201);

// 親の予定: 重なると不可 / 入れると子に即通知 / 子の申請が重なると不可 / 子は消せない
assert.equal((await call('POST', '/api/events', P, { start: '2026-11-15T12:00', end: '2026-11-15T13:00', place: '病院' })).status, 409);
pushes.length = 0;
r = await call('POST', '/api/events', P, { start: '2026-11-20T09:00', end: '2026-11-20T12:00', place: '病院' });
assert.equal(r.data.event.status, 'busy');
assert.equal(pushes.at(-1).body.to, 'U_SON');
assert.equal((await call('POST', '/api/events', S, { start: '2026-11-20T11:00', end: '2026-11-20T13:00', place: 'a' })).status, 409);
assert.equal((await call('DELETE', `/api/events/${r.data.event.id}`, S)).status, 403);

// 送信済みの時間を変えても有効のまま、親に通知
pushes.length = 0;
r = await call('PATCH', `/api/events/${id}`, S, { start: '2026-11-15T09:00', end: '2026-11-15T14:00' });
assert.equal(r.data.event.status, 'active');
assert.equal(pushes.at(-1).body.to, 'U_PAR');

// 否認 → 子にLINE(コメント付き)
pushes.length = 0;
r = await call('POST', `/api/events/${id}/decision`, P, { action: 'decline', comment: 'その日は使う' });
assert.equal(r.data.event.status, 'declined');
assert.equal(pushes.at(-1).body.to, 'U_SON');
assert.match(pushes.at(-1).body.messages[0].text, /否認/);
assert.match(pushes.at(-1).body.messages[0].text, /その日は使う/);
assert.equal((await call('POST', `/api/events/${id}/decision`, P, { action: 'approve' })).status, 400);
// 否認された枠は他の申請を邪魔しない
r = await call('POST', '/api/events', S, { start: '2026-11-15T09:30', end: '2026-11-15T10:30', place: 'b' });
assert.equal(r.status, 201);
// 否認の取り消しは、重なる予定があると不可
assert.equal((await call('POST', `/api/events/${id}/decision`, P, { action: 'restore' })).status, 409);
// まとめて送る(15:00〜16:00の'a'と'b')、取り消しで通知
pushes.length = 0;
r = await call('POST', '/api/send', S);
assert.equal(r.data.sent, 2);
assert.equal(pushes.length, 1);
pushes.length = 0;
const last = (await call('GET', '/api/events', S)).data.events.find((e) => e.place === 'b');
assert.equal((await call('DELETE', `/api/events/${last.id}`, S)).status, 200);
assert.equal(pushes.at(-1).body.to, 'U_PAR');
assert.equal((await call('GET', '/api/events/zzz', S)).status, 404);

// ---- くり返し ----
pushes.length = 0;
r = await call('POST', '/api/events', S, { start: '2026-12-01T10:00', end: '2026-12-01T12:00', place: '習い事の送迎', repeat: { type: 'weekly', until: '2026-12-29' } });
assert.equal(r.status, 201);
assert.deepEqual(r.data.events.map((e) => e.start.slice(0, 10)), ['2026-12-01', '2026-12-08', '2026-12-15', '2026-12-22', '2026-12-29']);
assert.equal(new Set(r.data.events.map((e) => e.seriesId)).size, 1);
assert.equal(pushes.length, 0); // 下書きなので通知なし
const series = r.data.events;
r = await call('POST', '/api/send', S);
assert.equal(pushes.length, 1); // まとめて1通
assert.match(pushes[0].body.messages[0].text, /毎週.*計5回/s);
// 1回だけ変更できる(他の回は変わらない)
r = await call('PATCH', `/api/events/${series[1].id}`, S, { start: '2026-12-08T13:00', end: '2026-12-08T15:00' });
assert.equal(r.status, 200);
let all = (await call('GET', '/api/events', S)).data.events.filter((e) => e.seriesId === series[0].seriesId);
assert.equal(all.find((e) => e.id === series[1].id).start, '2026-12-08T13:00');
assert.equal(all.find((e) => e.id === series[2].id).start, '2026-12-15T10:00');
// 1回だけ否認できる
r = await call('POST', `/api/events/${series[2].id}/decision`, P, { action: 'decline', comment: 'この日は無理' });
assert.equal(r.data.event.status, 'declined');
assert.equal((await call('GET', '/api/events', S)).data.events.filter((e) => e.seriesId === series[0].seriesId && e.status === 'active').length, 4);
// 重なる日だけ除外して登録
await call('POST', '/api/events', P, { start: '2027-01-12T09:00', end: '2027-01-12T18:00', place: '出張' });
r = await call('POST', '/api/events', S, { start: '2027-01-05T10:00', end: '2027-01-05T12:00', place: '送迎', repeat: { type: 'weekly', until: '2027-01-19' } });
assert.equal(r.data.events.length, 2);
assert.deepEqual(r.data.skipped.map((x) => x.start.slice(0, 10)), ['2027-01-12']);
// 隔週・毎月・上限・不正値
r = await call('POST', '/api/events', S, { start: '2027-03-01T10:00', end: '2027-03-01T11:00', place: 'x', repeat: { type: 'biweekly', until: '2027-03-29' } });
assert.deepEqual(r.data.events.map((e) => e.start.slice(0, 10)), ['2027-03-01', '2027-03-15', '2027-03-29']);
r = await call('POST', '/api/events', S, { start: '2027-05-31T10:00', end: '2027-06-01T02:00', place: 'y', repeat: { type: 'monthly', until: '2027-09-30' } });
assert.deepEqual(r.data.events.map((e) => e.start.slice(0, 10)), ['2027-05-31', '2027-07-31', '2027-08-31']);
assert.equal(r.data.events[0].end, '2027-06-01T02:00'); // 日またぎの長さも保つ
assert.equal((await call('POST', '/api/events', S, { start: '2028-01-01T10:00', end: '2028-01-01T11:00', place: 'z', repeat: { type: 'weekly', until: '2029-12-31' } })).status, 400);
assert.equal((await call('POST', '/api/events', S, { start: '2028-01-01T10:00', end: '2028-01-01T11:00', place: 'z', repeat: { type: 'daily', until: '2028-02-01' } })).status, 400);
assert.equal((await call('POST', '/api/events', S, { start: '2028-01-01T10:00', end: '2028-01-01T11:00', place: 'z', repeat: { type: 'weekly' } })).status, 400);
// 送って整理
r = await call('POST', '/api/send', S);
assert.equal(r.status, 200);
// この回以降をまとめて取り下げ(送信済み→通知は1通)
pushes.length = 0;
r = await call('DELETE', `/api/events/${series[3].id}?scope=following`, S);
assert.equal(r.data.removed, 2);
all = (await call('GET', '/api/events', S)).data.events.filter((e) => e.seriesId === series[0].seriesId);
assert.equal(all.length, 3);
assert.equal(pushes.length, 1);
assert.equal((await call('DELETE', `/api/events/${series[0].id}?scope=following`, P)).status, 403);

// ---- 下書きと親の予定が重なる ----
r = await call('POST', '/api/events', S, { start: '2027-02-01T10:00', end: '2027-02-01T12:00', place: 'd' });
assert.equal(r.status, 201);
assert.equal((await call('POST', '/api/events', P, { start: '2027-02-01T11:00', end: '2027-02-01T12:00', place: '用事' })).status, 201); // 下書きは親を邪魔しない
pushes.length = 0;
r = await call('POST', '/api/send', S);
assert.equal(r.status, 409); // 送る時に重なりを検知
assert.equal(pushes.length, 0);
assert.equal((await call('GET', '/api/events', S)).data.events.find((e) => e.place === 'd').status, 'draft');

console.log('all tests passed');
