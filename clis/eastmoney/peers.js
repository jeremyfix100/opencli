// eastmoney peers — same-industry peer comparison matrix for a stock.
//
//   opencli eastmoney peers 600519
//   opencli eastmoney peers 002241 --limit 15

import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError } from '@jackwener/opencli/errors';

function toSecucode(input) {
  const raw = String(input || '').trim().toUpperCase();
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(raw)) return raw;
  const pref = raw.match(/^(SH|SZ|BJ)(\d{6})$/);
  if (pref) return `${pref[2]}.${pref[1]}`;
  if (/^\d{6}$/.test(raw)) {
    if (/^(60|68|90|113|900)/.test(raw)) return `${raw}.SH`;
    if (/^(4|8|920|83|87)/.test(raw))    return `${raw}.BJ`;
    return `${raw}.SZ`;
  }
  throw new Error(`Unrecognized A-share symbol: ${input}`);
}

cli({
  site: 'eastmoney',
  name: 'peers',
  access: 'read',
  description: '同行业可比公司矩阵（PE/PB/ROE/毛利率等关键指标对比）',
  domain: 'push2.eastmoney.com',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'symbol', required: true, positional: true, help: 'A股代码（600519 / sh600519 等）' },
    { name: 'limit',  type: 'int',    default: 15,      help: '返回同行业公司数量 (max 50)' },
  ],
  columns: ['rank', 'code', 'name', 'price', 'pe', 'pb', 'marketCap', 'roe', 'grossMargin', 'netMargin', 'revenueGrowth', 'profitGrowth', 'industry'],
  func: async (args) => {
    let secucode;
    try { secucode = toSecucode(args.symbol); }
    catch (err) { throw new CliError('INVALID_ARGUMENT', `${err instanceof Error ? err.message : err}`); }
    const limit = Math.max(1, Math.min(Number(args.limit) || 15, 50));

    // Step 1: resolve the stock's industry classification
    const classifyUrl = new URL('https://push2.eastmoney.com/api/qt/clist/get');
    classifyUrl.searchParams.set('pn', '1');
    classifyUrl.searchParams.set('pz', '1');
    classifyUrl.searchParams.set('po', '0');
    classifyUrl.searchParams.set('np', '1');
    classifyUrl.searchParams.set('fltt', '2');
    classifyUrl.searchParams.set('invt', '2');
    classifyUrl.searchParams.set('fid', 'f3');
    classifyUrl.searchParams.set('fs', `b:${secucode.split('.')[0]}`);
    classifyUrl.searchParams.set('fields', 'f12,f14,f104,f105');
    classifyUrl.searchParams.set('ut', 'b2884a393a59ad64002292a3e90d46a5');

    const classResp = await fetch(classifyUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!classResp.ok) throw new CliError('HTTP_ERROR', `peers classify failed: HTTP ${classResp.status}`);
    const classData = await classResp.json();
    const classItem = Array.isArray(classData?.data?.diff) ? classData.data.diff[0] : null;
    const industryCode = classItem?.f104;
    if (!industryCode) throw new CliError('NO_DATA', `Could not resolve industry for ${secucode}`);

    // Step 2: get top stocks in the same industry
    const FIELDS = 'f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f14,f15,f16,f17,f18,f20,f21,f23,f25,f37,f38,f39,f40,f41,f45,f46,f57,f58,f115';
    const peersUrl = new URL('https://push2.eastmoney.com/api/qt/clist/get');
    peersUrl.searchParams.set('pn', '1');
    peersUrl.searchParams.set('pz', String(limit));
    peersUrl.searchParams.set('po', '0');
    peersUrl.searchParams.set('np', '1');
    peersUrl.searchParams.set('fltt', '2');
    peersUrl.searchParams.set('invt', '2');
    peersUrl.searchParams.set('fid', 'f3');
    peersUrl.searchParams.set('fs', `m:90+t:${industryCode}`);
    peersUrl.searchParams.set('fields', FIELDS);
    peersUrl.searchParams.set('ut', 'b2884a393a59ad64002292a3e90d46a5');

    const resp = await fetch(peersUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resp.ok) throw new CliError('HTTP_ERROR', `peers failed: HTTP ${resp.status}`);
    const data = await resp.json();
    const diff = Array.isArray(data?.data?.diff) ? data.data.diff : [];
    if (diff.length === 0) throw new CliError('NO_DATA', `No peer data for industry ${industryCode}`);

    return diff.slice(0, limit).map((it, i) => ({
      rank: i + 1,
      code: it.f12,
      name: it.f14,
      price: it.f2,
      pe: it.f9,
      pb: it.f23,
      marketCap: it.f20,
      roe: it.f37,
      grossMargin: it.f39,
      netMargin: it.f40,
      revenueGrowth: it.f57,
      profitGrowth: it.f58,
      industry: String(industryCode),
    }));
  },
});
