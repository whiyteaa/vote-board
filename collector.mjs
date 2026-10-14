// 采集器：在 GitHub Actions / 本地运行，抓两个渠道票数，写入 docs/data.json
// 渠道一: 无头浏览器加载 H5 页面（WAF+签名，协议直连不可行），读 Angular scope 前100名
// 渠道二: votezx 开放接口直连（全量297项）
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'docs', 'data.json');
const CH1_URL = 'https://h5vote.newaircloud.com/h5vote/3180?vSign=762b3f65a13240f8e634d8df5db5640d&withUserAgent=true';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

const out = { generatedAt: Date.now(), ch1: null, ch2: null };

// ---------- 渠道一 ----------
async function collectCh1() {
  let chromium = null, launchErr = [];
  try { ({ chromium } = await import('playwright')); } catch { try { ({ chromium } = await import('playwright-core')); } catch (e) { throw new Error('no playwright'); } }
  let browser = null;
  // 本地优先用系统 Chrome/Edge；Actions 用 playwright 自带 chromium
  const attempts = process.platform === 'win32'
    ? [{ channel: 'chrome' }, { channel: 'msedge' }, {}]
    : [{}, { channel: 'chrome' }];
  for (const opt of attempts) {
    try { browser = await chromium.launch({ headless: true, ...opt }); break; } catch (e) { launchErr.push(String(e.message).slice(0, 80)); }
  }
  if (!browser) throw new Error('launch failed: ' + launchErr.join(' | '));
  try {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 414, height: 896 }, locale: 'zh-CN' });
    const page = await ctx.newPage();
    await page.goto(CH1_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(`(() => {
      const el = document.querySelector('[ng-controller]');
      if (!el || !window.angular) return false;
      const s = angular.element(el).scope();
      return !!(s && s.globalDataOptions && s.globalDataOptions.length > 0);
    })()`, null, { timeout: 40_000, polling: 1000 });
    await page.evaluate(`(() => {
      const el = document.querySelector('[ng-controller]');
      const s = angular.element(el).scope();
      s.$apply(() => s.sortVoteNew('voteNumber', true));
    })()`);
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
    const items = data.map((x) => {
      const m = x.title.match(/^\s*(\d+)\s*[.、．]/);
      return m ? { no: m[1], title: x.title.replace(/^\s*\d+\s*[.、．]\s*/, ''), votes: x.votes } : null;
    }).filter(Boolean);
    if (!items.length) throw new Error('页面解析为空');
    return { items, updatedAt: Date.now(), note: '平台每视图最多展示票数前100名' };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------- 渠道二 ----------
async function collectCh2() {
  const headers = { 'Content-Type': 'application/json', 'User-Agent': UA, Origin: 'https://cacdexq.drag.votezx.com' };
  const [listRes, infoRes] = await Promise.all([
    fetch('https://api.votezx.com/api/vote/playersearch', { method: 'POST', headers, body: JSON.stringify({ action_id: 9853, page: 1, limit: 300, category: 0 }) }),
    fetch('https://api.votezx.com/api/vote/info', { method: 'POST', headers, body: JSON.stringify({ action_id: 9853, type: 3 }) }),
  ]);
  const j = await listRes.json();
  if (!j || j.code !== 1 || !j.data?.list) throw new Error(j?.msg || 'votezx 接口异常');
  const info = await infoRes.json();
  const items = j.data.list.map((x) => ({
    no: String(x.no), title: x.name, votes: Number(x.votenum) || 0, group: x.groupname_value || '',
  }));
  return {
    items,
    totalVotes: Number(info?.data?.votenum) || items.reduce((a, b) => a + b.votes, 0),
    updatedAt: Date.now(),
  };
}

for (const [key, fn] of [['ch1', collectCh1], ['ch2', collectCh2]]) {
  try {
    out[key] = await fn();
    console.log(`[${key}] ok: ${out[key].items.length} 项`);
  } catch (e) {
    out[key] = { error: String(e.message).slice(0, 200), updatedAt: Date.now() };
    console.log(`[${key}] FAILED: ${e.message}`);
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
console.log('written', OUT);
// 任一渠道成功即退出码0，全部失败退出码1
process.exit(out.ch1?.items || out.ch2?.items ? 0 : 1);
