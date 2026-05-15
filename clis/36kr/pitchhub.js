/**
 * 36kr pitchhub — financing events list (DOM scraping).
 *
 * Two modes:
 *   Whole mode: --years "2022"          → single query, auto-paginate
 *   Fragmented mode: --years "2022" --industries "9,10,11"
 *     → iterate each industry, crawl up to 1000 per industry, merge & dedupe
 *
 * Checkpoints data to disk after every page; --resume to continue from checkpoint.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError } from '@jackwener/opencli/errors';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CHECKPOINT_DIR = join(homedir(), '.opencli', 'sites', '36kr', 'checkpoints');
const CHECKPOINT_PATH = join(CHECKPOINT_DIR, 'pitchhub.json');

function readCheckpoint() {
  try {
    const raw = readFileSync(CHECKPOINT_PATH, 'utf-8');
    const data = JSON.parse(raw);
    if (Array.isArray(data) && data.length > 0) return data;
  } catch { /* no checkpoint */ }
  return null;
}

function writeCheckpoint(items) {
  mkdirSync(CHECKPOINT_DIR, { recursive: true });
  writeFileSync(CHECKPOINT_PATH, JSON.stringify(items));
}

function clearCheckpoint() {
  try { unlinkSync(CHECKPOINT_PATH); } catch { /* ok if missing */ }
}

function dedupeByUrl(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.projectUrl;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildUrl({ pageSize, pageNo, years, industryIdList, roundIdList }) {
  const url = new URL('https://pitchhub.36kr.com/investevent');
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('pageNo', String(pageNo));
  if (years && years.length > 0) {
    years.forEach((y, i) => {
      url.searchParams.set(`financingTimeList[${i}]`, String(y));
    });
  }
  if (industryIdList && industryIdList.length > 0) {
    industryIdList.forEach((id, i) => {
      url.searchParams.set(`industryIdList[${i}]`, String(id));
    });
  }
  if (roundIdList && roundIdList.length > 0) {
    roundIdList.forEach((id, i) => {
      url.searchParams.set(`financingRoundIdList[${i}]`, String(id));
    });
  }
  return url.toString();
}

async function scrapePage(page) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await page.evaluate('document.querySelectorAll(".table-row-body").length')) break;
    await new Promise(r => setTimeout(r, 300));
  }

  return await page.evaluate(`
    (() => {
      var rows = [];
      var rowEls = document.querySelectorAll('.table-row-body');
      for (var i = 0; i < rowEls.length; i++) {
        var row = rowEls[i];
        var cells = row.querySelectorAll('.item-content');
        if (cells.length < 6) continue;

        var date      = (cells[0] && cells[0].textContent || '').trim();
        var industry  = (cells[2] && cells[2].textContent || '').trim();
        var round     = (cells[3] && cells[3].textContent || '').trim();
        var amount    = (cells[4] && cells[4].textContent || '').trim();
        var investors = (cells[5] && cells[5].textContent || '').trim();

        var projectLink = row.querySelector('a.project-info');
        var projectName  = '';
        var projectBrief = '';
        var projectLogo  = '';
        var projectUrl   = '';
        if (projectLink) {
          var nameEl  = projectLink.querySelector('.projectName');
          var briefEl = projectLink.querySelector('.projectBrief');
          var imgEl   = projectLink.querySelector('img');
          projectName  = nameEl ? (nameEl.textContent || '').trim() : '';
          projectBrief = briefEl ? (briefEl.textContent || '').trim() : '';
          projectLogo  = imgEl ? (imgEl.src || '') : '';
          var href = projectLink.getAttribute('href') || '';
          projectUrl = href.indexOf('http') === 0 ? href : 'https://pitchhub.36kr.com' + href;
        }

        rows.push({
          financingDate: date,
          projectName: projectName,
          projectBrief: projectBrief,
          projectLogo: projectLogo,
          industry: industry,
          round: round,
          amount: amount,
          investors: investors,
          projectUrl: projectUrl,
        });
      }
      return rows;
    })()
  `);
}

/**
 * Crawl a single (years, industry) combination, returning up to `subLimit` items.
 */
async function crawlSegment(page, { perPage, subLimit, years, industryIdList, roundIdList, delayMs }) {
  const items = [];
  let pageNo = 1;

  while (items.length < subLimit) {
    let pageItems;

    try {
      const url = buildUrl({ pageSize: perPage, pageNo, years, industryIdList, roundIdList });
      await page.goto(url);
    } catch (_gotoErr) {
      break;
    }

    try {
      pageItems = await scrapePage(page);
    } catch (_scrapeErr) {
      break;
    }

    if (!pageItems || pageItems.length === 0) break;

    items.push(...pageItems);

    if (pageItems.length < perPage) break;

    pageNo++;

    if (items.length < subLimit && delayMs > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  return items.slice(0, subLimit);
}

cli({
  site: '36kr',
  name: 'pitchhub',
  access: 'read',
  description: '36氪融资事件库（整体/碎片爬取，自动翻页，断点续爬）',
  domain: 'pitchhub.36kr.com',
  strategy: Strategy.PUBLIC,
  browser: true,
  timeoutSeconds: 86400,
  args: [
    { name: 'limit',      type: 'int',    default: 100, help: '总条数上限 (default 100)' },
    { name: 'pageSize',   type: 'int',    default: 20,  help: '每页条数 (default 20, max 20)' },
    { name: 'pageNo',     type: 'int',    default: 1,   help: '起始页码 (default 1, 仅整体模式)' },
    { name: 'years',      type: 'string', default: '',   help: '融资年份，逗号分隔，如 "2026"' },
    { name: 'industries', type: 'string', default: '',   help: '行业ID列表，逗号分隔（碎片模式），如 "9,10,11"' },
    { name: 'rounds',     type: 'string', default: '',   help: '轮次ID列表，逗号分隔（碎片模式），如 "1,2,3"' },
    { name: 'delay',      type: 'int',    default: 500,  help: '翻页间隔毫秒 (default 500)' },
    { name: 'resume',     type: 'bool',   default: false, help: '从上次 checkpoint 断点续爬' },
  ],
  columns: ['financingDate', 'projectName', 'projectBrief', 'projectLogo', 'industry', 'round', 'amount', 'investors', 'projectUrl'],
  func: async (page, args) => {
    const limit      = Math.max(Number(args.limit) || 100, 1);
    const perPage    = Math.min(Math.max(Number(args.pageSize) || 20, 1), 20);
    const startNo    = Math.max(Number(args.pageNo) || 1, 1);
    const delayMs    = Math.max(Number(args.delay) ?? 500, 0);
    const resume     = args.resume === true || args.resume === 'true';
    const yearsRaw   = String(args.years ?? '').trim();
    const years      = yearsRaw ? yearsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
    const indRaw     = String(args.industries ?? '').trim();
    const industries = indRaw ? indRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
    const rndRaw     = String(args.rounds ?? '').trim();
    const rounds     = rndRaw ? rndRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

    let allItems = [];
    let hadAny   = false;

    if (resume) {
      const saved = readCheckpoint();
      if (saved && saved.length > 0) {
        allItems = saved;
        hadAny   = true;
      }
    }

    if (rounds.length > 0 && industries.length === 0) {
      // --- Round-only batch: no industry filter, one crawl per round ---
      for (const rndId of rounds) {
        if (allItems.length >= limit) break;

        const segItems = await crawlSegment(page, {
          perPage, subLimit: 1000, years,
          industryIdList: [],
          roundIdList: [rndId],
          delayMs,
        });

        if (segItems.length > 0) {
          allItems.push(...segItems);
          hadAny = true;
          writeCheckpoint(allItems);
        }
      }
    } else if (industries.length > 0) {
      const segRounds = rounds.length > 0 ? rounds : [''];

      // --- Fragmented/batch mode: one crawl per round, all industries batched ---
      for (const rndId of segRounds) {
        if (allItems.length >= limit) break;

        const segItems = await crawlSegment(page, {
          perPage,
          subLimit: 1000,
          years,
          industryIdList: industries,
          roundIdList: rndId ? [rndId] : [],
          delayMs,
        });

        if (segItems.length > 0) {
          allItems.push(...segItems);
          hadAny = true;
          writeCheckpoint(allItems);
        }
      }
    } else {
      // --- Whole mode: single query pagination ---
      let pageNo = startNo;

      while (allItems.length < limit) {
        let items;

        try {
          const url = buildUrl({ pageSize: perPage, pageNo, years, industryIdList: [], roundIdList: [] });
          await page.goto(url);
        } catch (_gotoErr) {
          if (allItems.length > 0) writeCheckpoint(allItems);
          break;
        }

        try {
          items = await scrapePage(page);
        } catch (_scrapeErr) {
          if (allItems.length > 0) writeCheckpoint(allItems);
          break;
        }

        if (!items || items.length === 0) {
          if (allItems.length > 0) writeCheckpoint(allItems);
          break;
        }

        allItems.push(...items);
        hadAny = true;
        writeCheckpoint(allItems);

        if (items.length < perPage) break;

        pageNo++;

        if (allItems.length < limit && delayMs > 0) {
          await new Promise(r => setTimeout(r, delayMs));
        }
      }
    }

    if (!hadAny) {
      throw new CliError('NO_DATA', '未能获取36氪融资事件数据', '36氪页面结构可能已变更');
    }

    const result = dedupeByUrl(allItems).slice(0, limit);

    clearCheckpoint();

    return result;
  },
});
