// eastmoney cross-financials — cross-check key financial indicators from a
// second source (sina finance) to validate eastmoney's numbers.
//
//   opencli eastmoney cross-financials 600519
//   opencli eastmoney cross-financials 002241 --years 3

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
  name: 'cross-financials',
  access: 'read',
  description: '财务数据交叉验证（sina source，与 eastmoney 主源对比）',
  domain: 'money.finance.sina.com.cn',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'symbol', required: true, positional: true, help: 'A股代码（600519 / sh600519 等）' },
    { name: 'years',  type: 'int',    default: 3,       help: '返回最近 N 年数据 (max 5)' },
  ],
  columns: ['year', 'revenue', 'netProfit', 'grossMargin', 'netMargin', 'ocf', 'totalAssets', 'totalLiabilities'],
  func: async (args) => {
    let secucode;
    try { secucode = toSecucode(args.symbol); }
    catch (err) { throw new CliError('INVALID_ARGUMENT', `${err instanceof Error ? err.message : err}`); }
    const years = Math.max(1, Math.min(Number(args.years) || 3, 5));

    // Sina finance financial summary API
    // Convert to sina format: sh600519, sz002241
    const code = secucode.replace('.SH', '').replace('.SZ', '').replace('.BJ', '');
    const prefix = secucode.endsWith('.SH') ? 'sh' : secucode.endsWith('.BJ') ? 'bj' : 'sz';
    const sinaCode = `${prefix}${code}`;

    const url = new URL(`https://money.finance.sina.com.cn/corp/go.php/vFD_FinanceSummary/stockid/${code}.phtml`);
    url.searchParams.set('type', 'api');
    url.searchParams.set('format', 'json');

    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://money.finance.sina.com.cn' },
    });

    if (!resp.ok) throw new CliError('HTTP_ERROR', `cross-financials failed: HTTP ${resp.status}`);

    const data = await resp.json();
    const rows = Array.isArray(data) ? data : [];
    if (rows.length === 0) throw new CliError('NO_DATA', `No financial data for ${sinaCode}`);

    // Take most recent N years
    const sorted = rows.slice(0, years);
    return sorted.map((it) => ({
      year: String(it.end_date || it.year || '').slice(0, 4),
      revenue: it.operate_income || it.revenue || '',
      netProfit: it.net_profit || '',
      grossMargin: it.gross_profit_rate || it.gross_margin || '',
      netMargin: it.net_profit_rate || '',
      ocf: it.operate_cash_flow || '',
      totalAssets: it.total_assets || '',
      totalLiabilities: it.total_liabilities || '',
    }));
  },
});
