// 通过 GitHub Contents API 只推送有变化的文件（对比 git blob sha，避免与 Actions 提交撞车）
import { execSync } from 'child_process';
import fs from 'fs';

const REPO = 'whiyteaa/vote-board';
const files = execSync('git -c core.quotepath=false ls-files', { encoding: 'utf8' }).trim().split('\n')
  .filter(Boolean)
  .filter((f) => f !== 'docs/data.json'); // data.json 由 Actions 采集维护，不本地推送

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pushed = 0, skipped = 0, failed = 0;

for (const f of files) {
  const localSha = execSync(`git hash-object "${f}"`, { encoding: 'utf8' }).trim();
  let remote = null;
  for (let i = 0; i < 3 && !remote; i++) {
    try {
      remote = JSON.parse(execSync(`gh api repos/${REPO}/contents/${f}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }));
    } catch (e) { await sleep(2000); }
  }
  if (remote && remote.sha === localSha) { skipped++; continue; }

  const b64 = fs.readFileSync(f).toString('base64');
  const body = { message: `update ${f}`, content: b64 };
  if (remote) body.sha = remote.sha; // 远端sha可能已被Actions推进，失败时重取
  let ok = false;
  for (let attempt = 0; attempt < 4 && !ok; attempt++) {
    try {
      execSync(`gh api -X PUT repos/${REPO}/contents/${f} --input -`, { input: JSON.stringify(body), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
      ok = true;
    } catch (e) {
      // 重新获取远端 sha 再试（分支头被并发提交推进时需要）
      try { const r2 = JSON.parse(execSync(`gh api repos/${REPO}/contents/${f}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })); body.sha = r2.sha; } catch (e2) {}
      await sleep(2500);
    }
  }
  if (ok) { pushed++; console.log('push:', f); }
  else { failed++; console.log('FAIL:', f); }
}
console.log(`done: pushed=${pushed} skipped=${skipped} failed=${failed}`);
if (failed) process.exit(1);
