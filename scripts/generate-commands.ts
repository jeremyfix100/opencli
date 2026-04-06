#!/usr/bin/env tsx
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

interface Command {
  site: string;
  name: string;
  description: string;
  domain: string;
  strategy: string;
  browser: boolean;
  args: { name: string; type: string; required: boolean; default?: number | string; help: string }[];
  columns: string[];
}

interface SiteGroup {
  site: string;
  category: 'cn' | 'en' | 'electron';
  domain: string;
  commands: Omit<Command, 'site'>[];
}

const CN_DOMAINS = ['.cn', '36kr.com', 'bilibili.com', 'zhihu.com', 'weibo.com', 'douban.com', 'taobao.com', 'jd.com', 'baidu.com', 'aliyun.com', 'tencent.com', 'sina.com.cn', 'sohu.com', '163.com', '126.com', 'qq.com', 'alipay.com', 'toutiao.com', 'xueqiu.com', 'hupu.com', 'smzdm.com', 'v2ex.com', 'xiachufang.com', 'douyin.com', 'kuaishou.com', 'meituan.com', 'dianping.com', 'ele.me', 'ctrip.com', '12306.cn', 'huya.com', 'douyu.com', 'longzhu.com', 'zhanqi.com', 'cc.163.com', 'game.163.com', 'music.163.com', 'mail.163.com', 'you.163.com', 'yanxuan.com', 'kaola.com', 'suning.com', 'gome.com.cn', 'vip.com', 'justpinyin.cn', 'pinduoduo.com', 'meituan.com', 'wmw.cn', 'xiangyung.cn', 'tujia.com', 'airbnb.cn', 'lianjia.com', 'anjuke.com', '58.com', 'ganji.com', 'baixing.com', 'dazhongdianping.com', 'diandian.com', 'paidai.com', 'wangdaishujia.com', 'cd.163.com', 'm.163.com', 'war.163.com', 'game.163.com', 'go.163.com', 'happy.163.com'];
const CN_SITES = ['36kr', 'bilibili', 'zhihu', 'xiaohongshu', 'weibo', 'douban', 'jd', 'taobao', 'alipay', 'toutiao', 'xueqiu', 'hupu', 'smzdm', 'v2ex', 'douyin', 'tiktok', 'kuaishou', 'meituan', 'dianping', 'ctrip', 'huya', 'douyu', 'xianyu', 'xiaoe', 'notion', 'ones', 'linux-do', 'band', 'zsxq', 'chaoxing', 'jike', 'xianyu', 'jimeng', 'yollomi', 'yuanbao', 'doubao', 'weread', 'xianyu'];

function getCategory(domain: string, site: string): 'cn' | 'en' | 'electron' {
  if (!domain || domain === 'localhost') return 'electron';
  if (CN_DOMAINS.some(d => domain.includes(d)) || CN_SITES.includes(site)) return 'cn';
  return 'en';
}

function main() {
  const manifestPath = join(rootDir, 'cli-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Command[];

  const siteMap = new Map<string, SiteGroup>();
  for (const cmd of manifest) {
    if (!siteMap.has(cmd.site)) {
      siteMap.set(cmd.site, {
        site: cmd.site,
        category: getCategory(cmd.domain, cmd.site),
        domain: cmd.domain,
        commands: []
      });
    }
    const site = siteMap.get(cmd.site)!;
    site.commands.push({
      name: cmd.name,
      description: cmd.description,
      domain: cmd.domain,
      strategy: cmd.strategy,
      browser: cmd.browser,
      args: cmd.args,
      columns: cmd.columns
    });
  }

  const outputDir = join(rootDir, 'docs/.vitepress/data');
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  
  const outputPath = join(outputDir, 'commands.json');
  writeFileSync(outputPath, JSON.stringify(Array.from(siteMap.values()), null, 2));
  console.log(`Generated ${siteMap.size} sites to ${outputPath}`);
}

main();
