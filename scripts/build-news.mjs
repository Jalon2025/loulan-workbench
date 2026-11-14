#!/usr/bin/env node
/* =============================================================================
 * 新闻资讯 · 实时抓取生成器（在 GitHub Actions 中运行）
 * -----------------------------------------------------------------------------
 * 每 30 分钟按 8 个板块的关键词抓取公开新闻 RSS，生成仓库根目录的
 * 「新闻资讯.js」（window.WB_NEWS）。页面切入新闻页时会跳过缓存重读该文件，
 * 因此电脑与手机端看到的都是最近一次抓取结果。
 *
 * 设计约束：
 *  - 纯静态站点没有后端，浏览器直连新闻源会被 CORS 挡，故抓取必须放在云端。
 *  - 抓不到足够条目时保留上一版文件，绝不把好数据换成空数据。
 *  - 生成内容会随 Pages 公开，禁止写入本机路径 / 账号 / 公众号名。
 *  - 本文件由 Workflow 调用，也可 `node build-news.mjs --self-test` 做离线单测。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.GITHUB_WORKSPACE || process.cwd();
const SEED = path.join(ROOT, 'scripts', 'seed-news.json');
const OUT = path.join(ROOT, '新闻资讯.js');
const SELF_TEST = process.argv.includes('--self-test');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const TIMEOUT = 12000;
const PER_SECTION = 6;      // 每板块最多实时条数
const STATIC_PER = 2;       // 每板块最多保留的常设入口卡

/* 8 个板块的关键词。Google News RSS 的 q 支持中文与空格（AND），when:7d 只取近 7 天。
 * queries  = 精准主词，优先用；
 * fallback = 主词命中不足时的宽泛兜底词（专业垂直词在中文新闻索引里常常一条都没有）；
 * must     = 兜底结果的相关性闸门，标题或摘要至少命中一个词才收，避免为凑数塞无关新闻。 */
const SECTIONS = [
  { id: 'oem', name: '汽车主机厂', icon: '🏭',
    desc: '整车厂战略、平台与新车型节奏 —— 决定灯具项目定点与开发周期的上游信号。',
    queries: ['汽车 主机厂 新车 发布', '车企 平台 战略 出海', '比亚迪 吉利 奇瑞 销量'],
    fallback: ['汽车 新车 上市', '车企 动态'] },
  { id: 'sales', name: '销量与爆款', icon: '📊',
    desc: '大盘数据与爆款车型，直接决定竞品灯具该拆谁、项目资源往哪投。',
    queries: ['乘用车 销量 乘联会', '新能源汽车 销量 榜单', '爆款车型 交付量'],
    fallback: ['汽车 销量', '新能源车 交付'] },
  { id: 'lamp', name: '车灯技术', icon: '💡',
    desc: '智能车灯的技术边界与合规红线，与配光、结构、光学、散热设计关联最紧。',
    queries: ['车灯 ADB 像素大灯', '智能车灯 贯穿式 尾灯', '汽车照明 DLP 光学'],
    fallback: ['汽车 大灯 车灯', '车灯 照明 技术'] },
  { id: 'ai', name: 'AI 要闻', icon: '🤖',
    desc: '影响写作与自动化工作流的模型 / Agent / 工具动态，优先看能直接上手的能力。',
    queries: ['大模型 Agent 发布', 'AI 编程 智能体', '多模态 模型 开源'],
    fallback: ['人工智能 大模型', 'AI 工具 发布'] },
  { id: 'cae', name: '仿真与 CAE', icon: '🧪',
    desc: 'Moldflow / Ansys / 3DEXPERIENCE 的版本更新与方法实践，关联注塑、结构与光学仿真。',
    queries: ['Moldflow 注塑 仿真', 'Ansys 仿真 新版本', 'SIMULIA Abaqus 3DEXPERIENCE'],
    fallback: ['仿真 工业软件', '汽车 仿真 设计', 'CAE 有限元', '注塑 模流 仿真',
               '数字孪生 制造', '仿真'],
    must: ['仿真', 'CAE', '有限元', '模流', '注塑', '模具', 'Ansys', 'Abaqus',
           'Moldflow', 'SIMULIA', '3DEXPERIENCE', '工业软件', '数字孪生', '数值模拟'] },
  { id: 'reg', name: '法规与标准', icon: '📐',
    desc: '强标与型式认证是车灯方案的硬边界，冻结设计前必查。',
    queries: ['汽车 强制性国家标准 灯光', 'GB 4785 前照灯 法规', '汽车 型式认证 新规'],
    fallback: ['汽车 国家标准', '汽车 新规 标准'] },
  { id: 'mat', name: '材料·模具与光学', icon: '🔬',
    desc: '灯壳胶槽、干燥密封、光导材料与注塑缺陷，是结构仿真最常见的失效来源。',
    queries: ['车灯 材料 光学 注塑', '聚碳酸酯 光导 车灯', '注塑 模具 缺陷 仿真'],
    fallback: ['汽车 材料 轻量化', '注塑 模具 工艺', '改性塑料 汽车',
               '光学 材料 车灯', '车灯 光学 设计'],
    must: ['材料', '注塑', '模具', '光学', '聚碳酸酯', '车灯', '塑料',
           '轻量化', '光导', '胶槽', '密封', '改性'] },
  { id: 'ip', name: '专利与内容选题', icon: '📝',
    desc: '把专利检索、竞品拆解与公众号选题串成一条线，让技术积累能复用成内容。',
    queries: ['汽车 车灯 专利 申请', '专利 检索 分析', 'AI 内容创作 工具'],
    fallback: ['汽车 专利', '专利 申请'] }
];

const KR_RSS = 'https://www.36kr.com/feed-newsflash';   // 辅源：有真实摘要的科技快讯
// 主源：国内可直访的公开 RSS，link 就是真实原文 URL。
// 不再用 Google 新闻 RSS —— 它的 link 是 news.google.com/rss/articles/CBMi...，
// 国内不可达，导致页面「阅读原文」点了没反应；且新版是内部 ID，无法本地解码。
const CN_FEEDS = [
  { name: 'IT之家',   url: 'https://www.ithome.com/rss/' },
  { name: '36氪',     url: 'https://www.36kr.com/feed-newsflash' },
  { name: '雷锋网',   url: 'https://www.leiphone.com/feed' },
  { name: '钛媒体',   url: 'https://www.tmtpost.com/rss.xml' },
  { name: '少数派',   url: 'https://sspai.com/feed' },
  { name: 'Solidot',  url: 'https://www.solidot.org/index.rss' }
];
const GOOGLE = 'https://news.google.com/rss/search';
// 私密串不写进本文件（它随 Pages 公开、也会上传到仓库 scripts/）；
// 需要启用时用环境变量 WB_NEWS_SECRETS 注入，多个用 | 分隔。
// 部署脚本在上传前另有敏感串检查兜底，公开内容不会泄漏。
const SECRETS = String(process.env.WB_NEWS_SECRETS || '').split('|')
  .map(x => x.trim()).filter(Boolean);
const hasSecret = s => SECRETS.length > 0 && SECRETS.some(x => s.includes(x));

/* ------------------------------ 通用工具 ------------------------------ */
const decode = s => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;|&#160;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&amp;/g, '&');
const stripHtml = s => decode(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const tagText = (block, name) => {
  const m = block.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i'));
  return m ? decode(m[1]) : '';
};
const norm = s => String(s || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
const bj = d => new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
const nowBJ = () => bj(new Date());

async function get(url, label) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/xml, text/xml, */*' }
    });
    if (!r.ok) { console.log('  ! ' + label + ' HTTP ' + r.status); return ''; }
    const text = await r.text();
    console.log('  ✓ ' + label + ' ' + text.length + ' bytes');
    return text;
  } catch (e) {
    console.log('  ! ' + label + ' ' + (e.name === 'AbortError' ? '超时' : String(e.message).slice(0, 60)));
    return '';
  } finally { clearTimeout(t); }
}

function parseRss(xml) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  return blocks.map(b => {
    const link = tagText(b, 'link').trim() ||
      ((b.match(/<link[^>]+href=["']([^"']+)["']/i) || [])[1] || '');
    let title = stripHtml(tagText(b, 'title'));
    let source = stripHtml(tagText(b, 'source'));
    // Google News 的标题形如「xxx - 媒体名」：无论有没有 <source> 都拆掉后缀，
    // 否则同一条新闻带/不带后缀时去重会漏，标题里也会混进媒体名
    const m = title.match(/^(.*?)\s+-\s+([^-]{2,24})$/);
    if (m) {
      title = m[1].trim();
      if (!source) source = m[2].trim();
    }
    const rawDate = tagText(b, 'pubDate').trim();
    const dt = rawDate ? new Date(rawDate) : null;
    return {
      title,
      url: link,
      desc: stripHtml(tagText(b, 'description')),
      source: source || '公开新闻源',
      date: dt && !isNaN(dt.getTime()) ? bj(dt) : '',
      // 前端 relTime()/freshTag() 按 UTC 解析 date，必须给 UTC 墙钟时间，
      // 否则北京时间字符串会被多吃 8 小时，实时条目被误标成「近期/回顾」
      dateUtc: dt && !isNaN(dt.getTime()) ? dt.toISOString().slice(0, 16).replace('T', ' ') : '',
      ts: dt && !isNaN(dt.getTime()) ? dt.getTime() : 0
    };
  }).filter(x => x.title && /^https?:\/\//.test(x.url));
}

function summarize(it, kw) {
  let d = (it.desc || '').replace(/\s+/g, ' ').trim();
  // Google News 的 description 多数只是「<a>标题</a> 来源」，清洗后与标题重复，不能当摘要
  const t = norm(it.title).slice(0, 14);
  if (d.length < 20 || (t && norm(d).includes(t)) || d === it.title) {
    d = [
      it.source && it.source !== '公开新闻源' ? it.source + ' 报道' : '',
      it.date ? it.date.slice(5) + ' 发布' : '',
      '由「' + kw + '」关键词自动聚合，点标题看原文全文'
    ].filter(Boolean).join(' · ');
  }
  return d.slice(0, 150);
}

function toItem(it, kw, hot) {
  return {
    title: it.title.slice(0, 120),
    summary: summarize(it, kw),
    source: it.source,
    date: it.dateUtc || it.date || '',   // UTC 墙钟时间，供前端算相对时间/分级
    tag: '动态',
    hot: !!hot,
    live: true,
    url: it.url
  };
}

/* ------------------------------ 抓取 ------------------------------ */
async function fetchGoogle(cfg, qs, when) {
  const out = [];
  for (const q of qs) {
    const win = when || '7d';
    const url = GOOGLE + '?q=' + encodeURIComponent(q + ' when:' + win) +
                '&hl=zh-CN&gl=CN&ceid=CN:zh-Hans';
    const xml = await get(url, cfg.id + ' / ' + q);
    const items = parseRss(xml).map(x => ({ ...x, kw: q }));
    console.log('      ' + q + ' (when:' + win + ') → ' + items.length + ' 条');
    out.push(...items);
    await new Promise(r => setTimeout(r, 250));   // 轻微限速，避免被判定为滥用
  }
  return out;
}

/* 相关性闸门：垂直板块的兜底词较宽，必须命中专业词才收，避免凑数塞无关新闻 */
function gate(cfg, it) {
  if (!cfg.must) return true;
  const s = (String(it.title || '') + ' ' + String(it.desc || '')).toLowerCase();
  return cfg.must.some(k => s.indexOf(k.toLowerCase()) >= 0);
}

async function fetch36kr() {
  const xml = await get(KR_RSS, '36kr 快讯（辅源）');
  return parseRss(xml).map(x => ({ ...x, kw: '科技快讯' }));
}

/* 把板块的 queries / fallback 短语拆成关键词，用于国内源的本地分发。
 * 国内 RSS 没有「按关键词搜索」能力，所以改成一次拉全量、本地打分归板块。 */
function kwTokens(cfg) {
  const set = new Set();
  (cfg.queries || []).concat(cfg.fallback || []).forEach(q => {
    String(q).split(/\s+/).forEach(w => { if (w.length >= 2) set.add(w.toLowerCase()); });
  });
  return [...set];
}
async function fetchDomestic() {
  const results = await Promise.all(CN_FEEDS.map(async f => {
    const xml = await get(f.url, f.name);
    return parseRss(xml).map(x => ({ ...x, source: x.source || f.name, kw: f.name }));
  }));
  const all = results.flat();
  console.log('国内源合计: ' + all.length + ' 条');
  const toks = Object.fromEntries(SECTIONS.map(c => [c.id, kwTokens(c)]));
  const by = Object.fromEntries(SECTIONS.map(c => [c.id, []]));
  all.forEach(it => {
    // 只收真实原文链接，杜绝任何 Google 新闻跳转页混入生成结果
    if (/news\.google\.com|\/rss\/articles\//i.test(it.url || '')) return;
    const hay = (String(it.title || '') + ' ' + String(it.desc || '')).toLowerCase();
    SECTIONS.map(c => ({ id: c.id, n: toks[c.id].reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0) }))
      .filter(x => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 2)
      .forEach(x => by[x.id].push(it));   // 一条最多进 2 个板块
  });
  SECTIONS.forEach(c => { by[c.id] = merge(by[c.id]).filter(x => gate(c, x)); });
  return by;
}

function merge(list) {
  const seen = new Set();
  return list
    .filter(x => {
      const k = norm(x.title);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => b.ts - a.ts);
}

/* ------------------------------ 生成 ------------------------------ */
function build(seed, freshBySection, kr) {
  const t = nowBJ();
  const seedMap = Object.fromEntries((seed.sections || []).map(s => [s.id, s]));
  let totalFresh = 0, staleSections = [];

  const sections = SECTIONS.map(cfg => {
    let list = merge(freshBySection[cfg.id] || []);
    if (cfg.id === 'ai' && list.length < 3 && kr.length) {
      // AI 板块用 36氪快讯补底（它有真实摘要）
      list = merge(list.concat(kr)).slice(0, PER_SECTION);
    }
    list = list.slice(0, PER_SECTION);
    const items = list.map((x, i) => toItem(x, x.kw || cfg.name, i < 2));

    // 常设情报入口：每板块最多 2 条，保证「实时流」之外还有长期可用的入口
    const sd = seedMap[cfg.id];
    const statics = (sd ? sd.items : []).filter(x => x.tag === '关注' || x.tag === '方法')
      .slice(0, STATIC_PER).map(x => ({ ...x, live: false, hot: false }));
    items.push(...statics);

    // 实时为 0 时整块回退到人工核实过的旧条目，并标记 stale
    if (!list.length) {
      staleSections.push(cfg.id);
      items.length = 0;
      items.push(...(sd ? sd.items : []).slice(0, 5).map(x => ({ ...x, live: false, stale: true })));
    }
    totalFresh += list.length;

    return {
      id: cfg.id, name: cfg.name, icon: cfg.icon, cadence: '30 分钟',
      desc: cfg.desc, fresh: list.length, items
    };
  });

  return {
    meta: { totalFresh, staleSections, generatedAt: t },
    data: {
      v: 2,
      live: true,
      updated: t,
      generatedAt: new Date().toISOString(),
      stale: staleSections.length > 0,
      lead: '云端每 30 分钟自动按板块关键词聚合公开新闻，最近生成于 ' + t +
            '（北京时间）。「实时」= 7 天内、「近期」= 30 天内、「回顾」= 更早；「关注」是长期有效的情报入口，点标题直达原文。',
      sections
    }
  };
}

function render(data) {
  const head = `/* 新闻资讯数据 · 个人工作台 —— 本文件由 GitHub Actions 自动生成，请勿手改
 * 生成时间：${data.updated}（北京时间）· 每 30 分钟更新一次
 * 数据源：公开新闻 RSS，按 8 个板块关键词聚合；失败时保留上一版。
 * 维护方式：改 scripts/build-news.mjs 的 SECTIONS.queries 即可调整关键词。
 * 注意：本文件随 Pages 公开，禁止写入本机路径、账号等私密信息。
 * --------------------------------------------------------------------------- */\n`;
  return head + 'window.WB_NEWS = ' + JSON.stringify(data, null, 2) + ';\n';
}

/* ------------------------------ 离线单测 ------------------------------ */
function selfTest() {
  const mock = `<?xml version="1.0"?><rss><channel>
  <item><title><![CDATA[某车企发布新一代智能车灯 - 盖世汽车]]></title>
  <link>https://example.com/a</link><description><![CDATA[<a href="x">某车企发布新一代智能车灯</a>&nbsp;&nbsp;盖世汽车]]></description>
  <pubDate>Fri, 07 Nov 2026 09:00:00 GMT</pubDate><source url="https://example.com">盖世汽车</source></item>
  <item><title>车灯 ADB 新规解读 - 中国汽车报</title><link>https://example.com/b</link>
  <description>这是一段足够长且信息完整的真实摘要，用来验证解析器不会把 description 误判成标题重复内容而替换掉。</description>
  <pubDate>Fri, 07 Nov 2026 08:00:00 GMT</pubDate></item>
  <item><title><![CDATA[某车企发布新一代智能车灯 - 盖世汽车]]></title><link>https://example.com/a</link>
  <pubDate>Fri, 07 Nov 2026 09:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const parsed = parseRss(mock);
  console.log('解析条目:', parsed.length, '| 去重后:', merge(parsed).length);
  console.log('来源拆分:', parsed[0].source, '| 时间(北京):', parsed[0].date);
  const a = summarize(parsed[0], '车灯 ADB');
  const b = summarize(parsed[1], '车灯 ADB');
  console.log('模板摘要:', a.slice(0, 70));
  console.log('真实摘要保留:', b.slice(0, 40));
  if (parsed.length !== 3 || merge(parsed).length !== 2) throw new Error('解析/去重失败');
  if (parsed[0].source !== '盖世汽车' || parsed[0].date !== '2026-11-07 17:00') throw new Error('来源/时间解析失败');
  if (parsed[0].dateUtc !== '2026-11-07 09:00') throw new Error('UTC 时间解析失败');
  if (!b.startsWith('这是一段足够长')) throw new Error('真实摘要被误替换');
  const seed = { sections: [{ id: 'lamp', items: [{ title: '常设入口', tag: '关注', summary: 'x', source: 'x', url: 'https://x.com' }] }] };
  const r = build(seed, { lamp: parsed }, []);
  console.log('生成板块:', r.data.sections.length, '| lamp 实时:', r.data.sections.find(s => s.id === 'lamp').fresh,
              '| 总实时:', r.meta.totalFresh, '| 降级板块:', r.meta.staleSections.join(','));
  const js = render(r.data);
  if (hasSecret(js)) throw new Error('含敏感串');
  global.window = {};
  new Function(js)();
  console.log('生成 JS 可执行 | window.WB_NEWS.sections =', global.window.WB_NEWS.sections.length);
  console.log('\nSELF TEST PASS');
}

/* ------------------------------ 主流程 ------------------------------ */
async function main() {
  if (SELF_TEST) return selfTest();
  const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  console.log('种子数据: ' + seed.sections.length + ' 板块 / ' +
              seed.sections.reduce((n, s) => n + s.items.length, 0) + ' 条');

  const kr = await fetch36kr();
  console.log('辅源 36氪快讯:', kr.length, '条');

  // 一次拉全部国内源，本地按板块关键词打分分发（不再逐板块打 Google 新闻 RSS）
  const freshBySection = await fetchDomestic();
  SECTIONS.forEach(cfg => console.log('  → ' + cfg.id + ' 有效 ' + freshBySection[cfg.id].length + ' 条'));

  const { meta, data } = build(seed, freshBySection, kr);
  console.log('\n实时条目合计: ' + meta.totalFresh + ' | 降级板块: ' +
              (meta.staleSections.join(',') || '无'));

  // 抓得太少说明源整体异常：保留上一版文件，不让页面变成空清单
  if (meta.totalFresh < 8) {
    console.error('实时条目不足 8 条，判定本次抓取失败 → 保留上一版 新闻资讯.js（不覆盖）');
    process.exit(0);
  }

  const js = render(data);
  if (hasSecret(js)) throw new Error('生成内容含敏感串，已中止');
  fs.writeFileSync(OUT, js, 'utf8');
  console.log('已生成 ' + OUT + ' (' + Buffer.byteLength(js, 'utf8') + ' bytes)');
  for (const s of data.sections) console.log('  ' + s.icon + ' ' + s.name + ' 实时 ' + s.fresh + ' / 共 ' + s.items.length);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
