import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runPoster, loadEnvFile, resolveDallyReportRoot } from '../generate-poster.mjs'

test('generate-poster: skips cleanly when no headlines exist', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poster-test-'))
  const res = await runPoster(tmp, '2026-09-15')
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'no_headlines')
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('generate-poster: 成功路径——海报 ok 后把 ![[AI.png]] 嵌入主标题下（deps 全注入，不烧生图 API）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poster-ok-'))
  fs.writeFileSync(path.join(tmp, '2026-09-15.verified-claims.json'), JSON.stringify({
    confirmed: [{ claim: 'OpenAI 发布 o5，性能翻倍' }, { claim: '带 http 的条目应被跳过 https://x.com/a' }],
  }))
  const md = '# 🤖 AI 日报 · 2026-09-15\n\n正文第一段\n'
  fs.writeFileSync(path.join(tmp, '2026-09-15-ai日报.md'), md)
  let gotCfg = null
  const fake = async (cfg, headlines) => {
    gotCfg = { cfg, headlines }
    return { ok: true, file: path.join(tmp, 'AI.png'), summary: 'success (fake)' }
  }
  const res = await runPoster(tmp, '2026-09-15', { generateAiPoster: fake })
  assert.equal(res.ok, true)
  assert.equal(gotCfg.headlines.length, 1, '含 http 的 claim 不进海报标题')
  assert.equal(gotCfg.headlines[0].title, 'OpenAI 发布 o5，性能翻倍')
  assert.equal(gotCfg.cfg.obsidianDir, tmp, 'outDir 基名≠date（tmp 测试）→ obsidianDir=outDir 本身，AI.png 与日报同目录')
  const after = fs.readFileSync(path.join(tmp, '2026-09-15-ai日报.md'), 'utf8')
  assert.match(after, /# 🤖 AI 日报[^\n]*\n\n!\[\[AI\.png\]\]/, '嵌入紧跟主标题后')
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('generate-poster: 幂等——已有 ![[AI.png]] 的 md 不重复嵌入；生图失败不写 md', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poster-idem-'))
  const md = '# 🤖 AI 日报 · 2026-09-15\n\n![[AI.png]]\n\n正文\n'
  fs.writeFileSync(path.join(tmp, '2026-09-15-ai日报.md'), md)
  fs.writeFileSync(path.join(tmp, '2026-09-15.verified-claims.json'), JSON.stringify({ confirmed: [{ claim: 'A 条新闻' }] }))
  const res = await runPoster(tmp, '2026-09-15', { generateAiPoster: async () => ({ ok: true, file: '/tmp/x/AI.png' }) })
  assert.equal(res.ok, true)
  assert.equal(fs.readFileSync(path.join(tmp, '2026-09-15-ai日报.md'), 'utf8'), md, '不重复嵌入')

  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'poster-fail-'))
  fs.writeFileSync(path.join(tmp2, '2026-09-15-ai日报.md'), md)
  const res2 = await runPoster(tmp2, '2026-09-15', { generateAiPoster: async () => ({ ok: false, summary: 'failed (IMG_NO_HEADLINES)' }) })
  assert.equal(res2.ok, false)
  assert.equal(fs.readFileSync(path.join(tmp2, '2026-09-15-ai日报.md'), 'utf8'), md, '生图失败不动 md')
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(tmp2, { recursive: true, force: true })
})

test('generate-poster: claims 损坏回落 sources.json；两者都无 headlines → no_headlines', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poster-src-'))
  fs.writeFileSync(path.join(tmp, '2026-09-15.verified-claims.json'), '{broken json')
  const res1 = await runPoster(tmp, '2026-09-15')
  assert.equal(res1.reason, 'no_headlines', 'claims 损坏且无 sources → 跳过')

  fs.writeFileSync(path.join(tmp, '2026-09-15.sources.json'), JSON.stringify({ sources: [{ title: '新闻标题A', board: 'linuxdo' }, { title: '' }] }))
  let got = null
  await runPoster(tmp, '2026-09-15', { generateAiPoster: async (cfg, hs) => { got = hs; return { ok: false, summary: 'x' } } })
  assert.equal(got.length, 1)
  assert.equal(got[0].title, '新闻标题A')
  assert.equal(got[0].provider, 'linuxdo')
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('loadEnvFile: 只补缺键不覆盖、跳过注释/空行、剥引号；文件缺失返回 0', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'env-'))
  const fp = path.join(tmp, '.env')
  fs.writeFileSync(fp, '# 注释\n\nA=1\nB="quoted"\nC=3\n')
  const env = { C: 'existing' }
  const n = loadEnvFile(fp, env)
  assert.equal(n, 2, 'C 已存在不覆盖，只补 A/B')
  assert.equal(env.A, '1')
  assert.equal(env.B, 'quoted')
  assert.equal(env.C, 'existing')
  assert.equal(loadEnvFile(path.join(tmp, 'missing.env'), env), 0)
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('resolveDallyReportRoot: obsidian 布局解析到真实 DallyReport 仓根；探测不到 → null', () => {
  const root = resolveDallyReportRoot()
  assert.ok(root, 'obsidian 布局下应探测到 DallyReport 根')
  assert.equal(path.basename(root), 'DallyReport')
  assert.equal(fs.existsSync(path.join(root, 'src', 'image-gen.mjs')), true, 'image-gen 可从该根解析')
  // 探测不到的假 fs → null（镜像布局探测分支由 resolve 顺序保证）
  const fakeFs = { existsSync: () => false }
  assert.equal(resolveDallyReportRoot(fakeFs), null)
})

test('runPoster: 依赖不可用（dallyReportRoot=null 且未注入 deps）→ 诚实跳过，不 throw', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poster-nodeps-'))
  fs.writeFileSync(path.join(tmp, '2026-09-15.verified-claims.json'), JSON.stringify({ confirmed: [{ claim: 'A 条新闻' }] }))
  const res = await runPoster(tmp, '2026-09-15', { dallyReportRoot: null })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'deps_unavailable')
  fs.rmSync(tmp, { recursive: true, force: true })
})
