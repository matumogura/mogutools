// 稼働状況の確認（GitHub Actions から5分おきに動く）
// 使い方: node status/check.mjs <記録ファイル status.json のパス>
// 記録は日ごと（日本時間）・サービスごとに「正常だった回数／止まっていた回数」だけを残す。
import fs from "node:fs";

const OUT = process.argv[2] || "status.json";
const KEEP_DAYS = 120;
const MACCHAN = process.env.MACCHAN_STATUS_URL || "https://macchan.onrender.com/status";
const SABOON_WEB = process.env.SABOON_WEB_URL || "https://saboon.pages.dev/";

async function get(url, ms = 30000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { "user-agent": "mogutools-status" }, cache: "no-store" });
    return r;
  } finally { clearTimeout(t); }
}

// 一度失敗しても、少し待ってもう一度だけ確かめる（一瞬のつまずきを「停止」にしない）
async function twice(fn) {
  const a = await fn().catch(() => null);
  if (a && a.allOk) return a;
  await new Promise((r) => setTimeout(r, 20000));
  return (await fn().catch(() => null)) || a;
}

async function checkMacchan() {
  const r = await get(MACCHAN);
  if (r.status === 404) return { skip: true, allOk: true };   // /status がまだ反映されていない（数えない）
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  const res = {
    bot: !!j.bot?.ok,
    web: !!j.web?.ok && !!j.db?.ok,
    sched: !!j.sched?.ok,
    saboon: !!j.saboon?.ok,
    guilds: j.bot?.guilds ?? null,
    startedAt: j.startedAt || null,
  };
  res.allOk = res.bot && res.web && res.sched && res.saboon;
  return res;
}
async function checkSaboonWeb() {
  const r = await get(SABOON_WEB);
  return { sbweb: r.ok, allOk: r.ok };
}

function jstDay(d = new Date()) {
  return new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
}

const now = new Date();
const m = (await twice(checkMacchan)) || { bot: false, web: false, sched: false, saboon: false };
const s = (await twice(checkSaboonWeb)) || { sbweb: false };
const result = m.skip ? { sbweb: s.sbweb } : { bot: m.bot, web: m.web, sched: m.sched, saboon: m.saboon, sbweb: s.sbweb };

let data = {};
try { data = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch {}
data.monitoringSince ||= now.toISOString();
data.days ||= {};
data.incidents ||= [];
const day = jstDay(now);
const D = (data.days[day] ||= {});
for (const [id, ok] of Object.entries(result)) {
  const c = (D[id] ||= [0, 0]);
  c[ok ? 0 : 1]++;
  // 止まった時間帯をまとめて残す（続いている間は終わりを更新）
  const open = data.incidents.find((x) => x.id === id && !x.to);
  if (!ok && !open) data.incidents.push({ id, from: now.toISOString(), to: null });
  if (!ok && open) open.last = now.toISOString();
  if (ok && open) open.to = now.toISOString();
}
// 古い記録を消す
const cut = jstDay(new Date(now.getTime() - KEEP_DAYS * 864e5));
for (const k of Object.keys(data.days)) if (k < cut) delete data.days[k];
data.incidents = data.incidents.filter((x) => !x.to || x.to.slice(0, 10) >= cut).slice(-200);
data.last = { at: now.toISOString(), result, guilds: m.guilds ?? data.last?.guilds ?? null, startedAt: m.startedAt ?? null };

fs.writeFileSync(OUT, JSON.stringify(data));
console.log(day, JSON.stringify(result));
