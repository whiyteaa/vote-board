// 双渠道投票实时统计聚合服务
// 渠道一: newaircloud H5 (中国交通报) — 有阿里云WAF+请求签名，无法纯协议访问，用无头浏览器读取
// 渠道二: votezx 扬帆评选 — 开放JSON接口，直连
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3456;
const POLL_MS = Number(process.env.POLL_MS || 60_000);
const CH1_URL = 'https://h5vote.newaircloud.com/h5vote/3180?vSign=762b3f65a13240f8e634d8df5db5640d&withUserAgent=true';
const CH2_API = 'https://api.votezx.com/api/vote/playersearch';
const CH2_ORIGIN = 'https://cacdexq.drag.votezx.com';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

const state = {
  ch1: { items: [], updatedAt: null, error: null, totalVotes: null, status: 'init' },
  ch2: { items: [], updatedAt: null, error: null, totalVotes: null, status: 'init' },
  history: [], // [{t, map:{no:votes}}] 最近若干次快照，用于计算增量
};

// ---------------- 渠道一：无头浏览器 ----------------
let browser = null;
let page = null;

async function launchCh1() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      browser = await chromium.launch({ channel, headless: true });
      return;
    } catch (e) { /* try next */ }
  }
  throw new Error('未找到可用的 Chrome/Edge');
}

const SCOPE_READY = `(() => {
  const el = document.querySelector('[ng-controller]');
  if (!el || !window.angular) return false;
  const s = angular.element(el).scope();
  return !!(s && s.globalDataOptions && s.globalDataOptions.length > 0);
})()`;

async function ch1Collect() {
  if (!browser) await launchCh1();
  if (!page || page.isClosed()) {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 414, height: 896 }, locale: 'zh-CN' });
    page = await ctx.newPage();
  }
  state.ch1.status = 'loading';
  // 每轮重新加载页面，保证会话干净
  await page.goto(CH1_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForFunction(SCOPE_READY, null, { timeout: 30_000, polling: 1000 });
  // 触发"按票数排序"，服务端按票数返回前100（该渠道每视图最多100项）
  await page.evaluate(`(() => {
    const el = document.querySelector('[ng-controller]');
    const s = angular.element(el).scope();
    s.$apply(() => s.sortVoteNew('voteNumber', true));
  })()`);
  // 等待排序数据替换完成（长度稳定）
  let lastLen = -1, stable = 0;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(800);
    const len = await page.evaluate(`angular.element(document.querySelector('[ng-controller]')).scope().globalDataOptions.length`);
    if (len === lastLen) { stable++; if (stable >= 2 && len >= 100) break; } else { stable = 0; lastLen = len; }
  }
  const data = await page.evaluate(`(() => {
    const s = angular.element(document.querySelector('[ng-controller]')).scope();
    return s.globalDataOptions.map(o => ({ title: String(o.title || ''), votes: Number(o.optionNum) || 0 }));
  })()`);
  const items = data
    .map((x) => {
      const m = x.title.match(/^\s*(\d+)\s*[.、．]/);
      return m ? { no: m[1], title: x.title.replace(/^\s*\d+\s*[.、．]\s*/, ''), votes: x.votes } : null;
    })
    .filter(Boolean);
  if (!items.length) throw new Error('未能从页面解析出选项');
  state.ch1.items = items;
  state.ch1.totalVotes = items.reduce((a, b) => a + b.votes, 0);
  state.ch1.updatedAt = Date.now();
  state.ch1.error = null;
  state.ch1.status = 'ok';
}

async function ch1Poll() {
  try {
    await ch1Collect();
  } catch (e) {
    state.ch1.status = 'error';
    state.ch1.error = e.message;
    // 出错时重建浏览器
    try { if (browser) await browser.close(); } catch {}
    browser = null; page = null;
  }
}

// ---------------- 渠道二：直连API ----------------
async function ch2Collect() {
  state.ch2.status = 'loading';
  const res = await fetch(CH2_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      Origin: CH2_ORIGIN,
      Referer: `${CH2_ORIGIN}/`,
    },
    body: JSON.stringify({ action_id: 9853, page: 1, limit: 300, category: 0 }),
  });
  const j = await res.json();
  if (!j || j.code !== 1 || !j.data || !Array.isArray(j.data.list)) throw new Error(j?.msg || '接口返回异常');
  const info = await (await fetch('https://api.votezx.com/api/vote/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Origin: CH2_ORIGIN },
    body: JSON.stringify({ action_id: 9853, type: 3 }),
  })).json();
  state.ch2.items = j.data.list.map((x) => ({
    no: String(x.no),
    title: x.name,
    votes: Number(x.votenum) || 0,
    group: x.groupname_value || '',
    clicks: Number(x.click) || 0,
  }));
  state.ch2.totalVotes = Number(info?.data?.votenum) || state.ch2.items.reduce((a, b) => a + b.votes, 0);
  state.ch2.updatedAt = Date.now();
  state.ch2.error = null;
  state.ch2.status = 'ok';
}

async function ch2Poll() {
  try {
    await ch2Collect();
  } catch (e) {
    state.ch2.status = 'error';
    state.ch2.error = e.message;
  }
}

// ---------------- 合并 ----------------
function buildMerged() {
  const map = new Map();
  for (const it of state.ch1.items) {
    map.set(it.no, { no: it.no, title: it.title, ch1: it.votes, ch2: null, group: '' });
  }
  for (const it of state.ch2.items) {
    const cur = map.get(it.no);
    if (cur) { cur.ch2 = it.votes; cur.group = it.group; if (!cur.title) cur.title = it.title; }
    else map.set(it.no, { no: it.no, title: it.title, ch1: null, ch2: it.votes, group: it.group });
  }
  const rows = [...map.values()].map((r) => ({ ...r, total: (r.ch1 || 0) + (r.ch2 || 0) }));
  rows.sort((a, b) => b.total - a.total || b.ch1 - a.ch1 || b.ch2 - a.ch2 || a.no.localeCompare(b.no));
  rows.forEach((r, i) => { r.rank = i + 1; });
  // 与上一份快照对比增量（history 末位是本次刚存的，取倒数第二份）
  const prev = state.history.length > 1 ? state.history[state.history.length - 2] : null;
  if (prev) {
    for (const r of rows) {
      const p = prev.m[r.no];
      r.delta = p == null ? null : r.total - p;
    }
  }
  return rows;
}

function snapshot() {
  if (!state.ch1.items.length && !state.ch2.items.length) return;
  const m = {};
  for (const it of state.ch1.items) m[it.no] = (m[it.no] || 0) + it.votes;
  for (const it of state.ch2.items) m[it.no] = (m[it.no] || 0) + it.votes;
  state.history.push({ t: Date.now(), m });
  if (state.history.length > 30) state.history.shift();
}

// ---------------- HTTP ----------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  } else if (url.pathname === '/api/merged') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      now: Date.now(),
      rows: buildMerged(),
      ch1: { ...state.ch1, items: undefined, count: state.ch1.items.length },
      ch2: { ...state.ch2, items: undefined, count: state.ch2.items.length },
    }));
  } else if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ch1: state.ch1.status, ch2: state.ch2.status, ch1err: state.ch1.error, ch2err: state.ch2.error }));
  } else {
    res.writeHead(404); res.end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[vote-monitor] http://127.0.0.1:${PORT}`);
});

async function tick() {
  await Promise.all([ch1Poll(), ch2Poll()]);
  snapshot();
  console.log(`[${new Date().toLocaleTimeString()}] ch1=${state.ch1.status}(${state.ch1.items.length}项) ch2=${state.ch2.status}(${state.ch2.items.length}项)`);
}
tick().catch((e) => console.log('tick error', e.message));
setInterval(() => { tick().catch((e) => console.log('tick error', e.message)); }, POLL_MS);

process.on('exit', () => { try { browser?.close(); } catch {} });
