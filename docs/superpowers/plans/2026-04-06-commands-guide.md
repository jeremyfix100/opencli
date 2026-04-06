# Commands Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建一个功能指南页面，展示所有支持的站点、命令行及其数据结构

**Architecture:** 从 cli-manifest.json 动态生成 JSON 数据，用 VitePress + Vue 3 实现交互式页面

**Tech Stack:** VitePress, Vue 3, TypeScript, JSON

---

### Task 1: 创建数据生成脚本

**Files:**
- Create: `scripts/generate-commands.ts`

- [ ] **Step 1: 创建脚本文件**

```typescript
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
  if (domain === 'localhost') return 'electron';
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
```

- [ ] **Step 2: 添加 package.json 脚本**

Modify: `package.json:62`
添加 `"docs:commands": "tsx scripts/generate-commands.ts"`

- [ ] **Step 3: 运行脚本测试**

Run: `npm run docs:commands`
Expected: 生成 `docs/.vitepress/data/commands.json`

---

### Task 2: 创建 Vue 组件

**Files:**
- Create: `docs/.vitepress/components/CommandsExplorer.vue`

- [ ] **Step 1: 创建 Vue 组件**

```vue
<template>
  <div class="commands-explorer">
    <div class="search-bar">
      <input
        v-model="searchQuery"
        type="text"
        placeholder="搜索站点或命令..."
        class="search-input"
      />
    </div>

    <div class="category-tabs">
      <button
        v-for="cat in categories"
        :key="cat.value"
        :class="['tab', { active: activeCategory === cat.value }]"
        @click="activeCategory = cat.value"
      >
        {{ cat.label }}
        <span class="count">({{ getCategoryCount(cat.value) }})</span>
      </button>
    </div>

    <div class="sites-grid">
      <div
        v-for="site in filteredSites"
        :key="site.site"
        :class="['site-card', { expanded: expandedSite === site.site }]"
        @click="toggleSite(site.site)"
      >
        <div class="site-header">
          <h3>{{ site.site }}</h3>
          <span class="domain">{{ site.domain }}</span>
          <span :class="['badge', site.category]">{{ site.category.toUpperCase() }}</span>
        </div>
        <div class="site-commands-count">{{ site.commands.length }} commands</div>
        
        <div v-if="expandedSite === site.site" class="site-details">
          <div
            v-for="cmd in site.commands"
            :key="cmd.name"
            class="command-item"
          >
            <div class="command-header">
              <code class="command-name">opencli {{ site.site }} {{ cmd.name }}</code>
            </div>
            <p class="command-desc">{{ cmd.description }}</p>
            
            <div v-if="cmd.args.length" class="command-args">
              <strong>参数:</strong>
              <ul>
                <li v-for="arg in cmd.args" :key="arg.name">
                  <code>{{ arg.name }}</code>
                  <span v-if="arg.default">={{ arg.default }}</span>
                  <span v-if="arg.required" class="required">*</span>
                  - {{ arg.help }}
                </li>
              </ul>
            </div>
            
            <div class="command-columns">
              <strong>输出字段:</strong>
              <code v-for="col in cmd.columns" :key="col" class="column-tag">{{ col }}</code>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="filteredSites.length === 0" class="no-results">
      没有找到匹配的站点或命令
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import commandsData from '../data/commands.json';

interface Command {
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
  commands: Command[];
}

const searchQuery = ref('');
const activeCategory = ref('all');
const expandedSite = ref<string | null>(null);

const categories = [
  { value: 'all', label: '全部' },
  { value: 'cn', label: '中文站点' },
  { value: 'en', label: '英文站点' },
  { value: 'electron', label: 'Electron App' }
] as const;

const sites = ref<SiteGroup[]>(commandsData as SiteGroup[]);

const filteredSites = computed(() => {
  return sites.value.filter(site => {
    if (activeCategory.value !== 'all' && site.category !== activeCategory.value) {
      return false;
    }
    if (searchQuery.value) {
      const query = searchQuery.value.toLowerCase();
      const matchSite = site.site.toLowerCase().includes(query);
      const matchCmd = site.commands.some(cmd => 
        cmd.name.toLowerCase().includes(query) ||
        cmd.description.toLowerCase().includes(query)
      );
      return matchSite || matchCmd;
    }
    return true;
  });
});

function getCategoryCount(category: string) {
  if (category === 'all') return sites.value.length;
  return sites.value.filter(s => s.category === category).length;
}

function toggleSite(siteName: string) {
  expandedSite.value = expandedSite.value === siteName ? null : siteName;
}
</script>

<style scoped>
.commands-explorer {
  max-width: 1200px;
  margin: 0 auto;
}

.search-bar {
  margin-bottom: 20px;
}

.search-input {
  width: 100%;
  padding: 12px 16px;
  font-size: 16px;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  background: #fff;
}

.search-input:focus {
  outline: none;
  border-color: #0070f3;
}

.category-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 24px;
  flex-wrap: wrap;
}

.tab {
  padding: 8px 16px;
  border: 1px solid #e0e0e0;
  border-radius: 20px;
  background: #fff;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.2s;
}

.tab:hover {
  border-color: #0070f3;
}

.tab.active {
  background: #0070f3;
  color: #fff;
  border-color: #0070f3;
}

.count {
  opacity: 0.7;
  margin-left: 4px;
}

.sites-grid {
  display: grid;
  gap: 16px;
}

.site-card {
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 16px;
  background: #fff;
  cursor: pointer;
  transition: all 0.2s;
}

.site-card:hover {
  border-color: #0070f3;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}

.site-card.expanded {
  border-color: #0070f3;
}

.site-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.site-header h3 {
  margin: 0;
  font-size: 18px;
}

.domain {
  color: #666;
  font-size: 14px;
}

.badge {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
}

.badge.cn {
  background: #fff7ed;
  color: #c2410c;
}

.badge.en {
  background: #eff6ff;
  color: #1d4ed8;
}

.badge.electron {
  background: #f0fdf4;
  color: #15803d;
}

.site-commands-count {
  color: #666;
  font-size: 14px;
}

.site-details {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid #e0e0e0;
}

.command-item {
  padding: 12px;
  margin-bottom: 12px;
  background: #f9f9f9;
  border-radius: 6px;
}

.command-header {
  margin-bottom: 8px;
}

.command-name {
  background: #e8e8e8;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 13px;
}

.command-desc {
  margin: 8px 0;
  color: #444;
}

.command-args {
  margin: 12px 0;
}

.command-args ul {
  margin: 8px 0;
  padding-left: 20px;
}

.command-columns {
  margin-top: 12px;
}

.column-tag {
  display: inline-block;
  background: #e8e8e8;
  padding: 2px 8px;
  margin: 2px;
  border-radius: 4px;
  font-size: 12px;
}

.no-results {
  text-align: center;
  padding: 40px;
  color: #666;
}
</style>
```

- [ ] **Step 2: 测试组件文件创建**
确认文件路径正确: `docs/.vitepress/components/CommandsExplorer.vue`

---

### Task 3: 创建 Markdown 页面

**Files:**
- Create: `docs/guide/commands.md`

- [ ] **Step 1: 创建页面文件**

```markdown
# Commands Guide

Explore all supported sites and commands in OpenCLI.

<script setup>
import CommandsExplorer from '../components/CommandsExplorer.vue'
</script>

<CommandsExplorer />
```

---

### Task 4: 配置 Sidebar

**Files:**
- Modify: `docs/.vitepress/config.mts:35`

- [ ] **Step 1: 添加 sidebar 入口**

在 sidebar 的 `/guide/` 部分添加:
```ts
{ text: 'Commands Guide', link: '/guide/commands' },
```

---

### Task 5: 测试构建

**Files:**
- Run: `npm run docs:commands && npm run docs:build`

- [ ] **Step 1: 运行数据生成**

Run: `npm run docs:commands`
Expected: 输出包含站点数量

- [ ] **Step 2: 构建文档**

Run: `npm run docs:build`
Expected: 构建成功，无错误

- [ ] **Step 3: 本地预览（可选）**

Run: `npm run docs:preview`
Expected: 页面可访问

---

### Task 6: 提交

- [ ] **Step 1: 提交更改**

```bash
git add docs/.vitepress/data/commands.json docs/.vitepress/components/CommandsExplorer.vue docs/guide/commands.md docs/.vitepress/config.mts scripts/generate-commands.ts package.json
git commit -m "feat(docs): add commands guide page"
```
