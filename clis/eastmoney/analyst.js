// eastmoney analyst — analyst consensus ratings and target prices for a stock.
//
//   opencli eastmoney analyst 600519
//   opencli eastmoney analyst 002241 --limit 20

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
  name: 'analyst',
  access: 'read',
  description: '券商研报评级与目标价（一致预期）',
  domain: 'datacenter-web.eastmoney.com',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'symbol', required: true, positional: true, help: 'A股代码（600519 / sh600519 等）' },
    { name: 'limit',  type: 'int',    default: 10,      help: '返回研报数量 (max 50)' },
  ],
  columns: ['date', 'broker', 'analyst', 'rating', 'targetHigh', 'targetLow', 'reportTitle'],
  func: async (args) => {
    /** @type {string} */
    let secucode;
    try { secucode = toSecucode(args.symbol); }
    catch (err) { throw new CliError('INVALID_ARGUMENT', `${err instanceof Error ? err.message : err}`); }
    const limit = Math.max(1, Math.min(Number(args.limit) || 10, 50));

    const url = new URL('https://datacenter-web.eastmoney.com/api/data/v1/get');
    url.searchParams.set('reportName', 'RPT_WEB_RESOP_EM');
    url.searchParams.set('columns', 'SECUCODE,SECURITY_NAME_ABBR,RESPUBNAME,RESPERSON,STAR_RATING,RATING_NAME,RATING_CHANGE,INDICATE_TYPE,NEWEST_DATE,PRICE_TARGET,HIGH_PRICE_TARGET,LOW_PRICE_TARGET,TRADE_OP_NAME,TITLE');
    url.searchParams.set('pageSize', String(limit));
    url.searchParams.set('pageNumber', '1');
    url.searchParams.set('sortColumns', 'NEWEST_DATE');
    url.searchParams.set('sortTypes', '-1');
    url.searchParams.set('source', 'WEB');
    url.searchParams.set('client', 'WEB');
    url.searchParams.set('filter', `(SECUCODE="${secucode}")`);

    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
    if (!resp.ok) throw new CliError('HTTP_ERROR', `analyst failed: HTTP ${resp.status}`);
    const data = await resp.json();
    const rows = Array.isArray(data?.result?.data) ? data.result.data : [];
    if (rows.length === 0) throw new CliError('NO_DATA', `No analyst reports found for ${secucode}`);

    return rows.slice(0, limit).map((it) => ({
      date: String(it.NEWEST_DATE || '').slice(0, 10),
      broker: it.RESPUBNAME || '',
      analyst: it.RESPERSON || '',
      rating: it.RATING_NAME || it.STAR_RATING || '',
      targetHigh: it.HIGH_PRICE_TARGET ?? it.PRICE_TARGET ?? '',
      targetLow: it.LOW_PRICE_TARGET ?? '',
      reportTitle: it.TITLE || '',
    }));
  },
});
