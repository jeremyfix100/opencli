<template>
  <div class="commands-explorer">
    <div class="header-row">
      <input
        :value="searchQuery"
        @input="searchQuery = ($event.target as HTMLInputElement).value"
        type="text"
        placeholder="搜索站点、命令..."
        class="search-input"
      />
      <div class="industry-tabs">
        <button
          v-for="ind in industries"
          :key="ind.value"
          :class="['tab', { active: activeIndustry === ind.value }]"
          @click="activeIndustry = ind.value"
        >
          {{ ind.label }}
          <span class="count">({{ getIndustryCount(ind.value) }})</span>
        </button>
      </div>
    </div>

    <div class="sites-table">
      <div class="table-header">
        <span class="col-site">站点</span>
        <span class="col-industry">类型</span>
        <span class="col-commands">命令</span>
        <span class="col-desc">简介</span>
      </div>
      <div
        v-for="site in filteredSites"
        :key="site.site"
        :class="['table-row', { expanded: expandedSite === site.site }]"
      >
        <div class="row-main" @click="toggleSite(site.site)">
          <span class="col-site">
            <strong>{{ site.site }}</strong>
            <small class="domain">{{ site.domain }}</small>
          </span>
          <span :class="['col-industry', 'badge', site.industry]">{{ getIndustryLabel(site.industry) }}</span>
          <span class="col-commands">
            <span
              v-for="cmd in site.commands.slice(0, 8)"
              :key="cmd.name"
              class="cmd-tag"
              :title="cmd.name"
            >{{ cmd.name }}</span>
            <span v-if="site.commands.length > 8" class="more">+{{ site.commands.length - 8 }}</span>
          </span>
          <span class="col-desc">{{ getCommandSummary(site) }}</span>
        </div>
        <div v-if="expandedSite === site.site" class="row-details" @click.stop>
          <div
            v-for="cmd in site.commands"
            :key="cmd.name"
            class="command-item"
          >
            <div class="cmd-header">
              <code class="cmd-full" @click="copyCommand(site.site, cmd.name)" title="点击复制">{{ site.site }} {{ cmd.name }}</code>
              <span class="cmd-desc">{{ cmd.description }}</span>
            </div>
            <div class="cmd-meta">
              <span v-if="cmd.args.length" class="meta-line">
                <span class="meta-label">参数</span>：
                <span v-for="(arg, i) in cmd.args" :key="arg.name" class="arg-tag" :title="arg.help">
                  {{ arg.name }}{{ arg.default ? `=${arg.default}` : '' }}{{ arg.required ? '*' : '' }}{{ i < cmd.args.length - 1 ? ', ' : '' }}
                </span>
              </span>
              <span v-if="cmd.columns.length" class="meta-line">
                <span class="meta-label">返回</span>：
                <span v-for="(col, i) in cmd.columns" :key="col" class="col-tag">{{ col }}{{ i < cmd.columns.length - 1 ? ', ' : '' }}</span>
              </span>
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
import commandsData from '../../../.vitepress/data/commands.json';

type Industry = 'news' | 'social' | 'video' | 'ecommerce' | 'developer' | 'finance' | 'ai' | 'electron' | 'other';

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
  industry: Industry;
  domain: string;
  commands: Command[];
}

const searchQuery = ref('');
const activeIndustry = ref('all');
const expandedSite = ref<string | null>(null);

const INDUSTRY_LABELS: Record<Industry, string> = {
  news: '资讯',
  social: '社区',
  video: '视频',
  ecommerce: '电商',
  developer: '开发',
  finance: '金融',
  ai: 'AI',
  electron: 'App',
  other: '其他'
};

const industries = [
  { value: 'all', label: '全部' },
  { value: 'ai', label: 'AI' },
  { value: 'social', label: '社区' },
  { value: 'video', label: '视频' },
  { value: 'news', label: '资讯' },
  { value: 'ecommerce', label: '电商' },
  { value: 'developer', label: '开发' },
  { value: 'finance', label: '金融' },
  { value: 'electron', label: 'App' }
] as const;

const sites = ref<SiteGroup[]>(commandsData as SiteGroup[]);

const filteredSites = computed(() => {
  return sites.value.filter(site => {
    if (activeIndustry.value !== 'all' && site.industry !== activeIndustry.value) {
      return false;
    }
    if (searchQuery.value) {
      const query = searchQuery.value.toLowerCase();
      const matchSite = site.site.toLowerCase().includes(query);
      const matchDomain = site.domain.toLowerCase().includes(query);
      const matchCmd = site.commands.some(cmd => 
        cmd.name.toLowerCase().includes(query) ||
        cmd.description.toLowerCase().includes(query)
      );
      return matchSite || matchDomain || matchCmd;
    }
    return true;
  });
});

function getIndustryCount(industry: string) {
  if (industry === 'all') return sites.value.length;
  return sites.value.filter(s => s.industry === industry).length;
}

function getIndustryLabel(industry: Industry): string {
  return INDUSTRY_LABELS[industry] || industry;
}

function getCommandSummary(site: SiteGroup): string {
  const names = site.commands.slice(0, 3).map(c => c.name).join(', ');
  return site.commands.length > 3 ? `${names}...` : names;
}

function toggleSite(siteName: string) {
  expandedSite.value = expandedSite.value === siteName ? null : siteName;
}

async function copyCommand(site: string, cmd: string) {
  const text = `opencli ${site} ${cmd}`;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
}
</script>

<style scoped>
.commands-explorer {
  max-width: 1600px;
  margin: 0 auto;
  font-size: 13px;
}

.header-row {
  display: flex;
  gap: 16px;
  margin-bottom: 16px;
  flex-wrap: wrap;
  align-items: center;
}

.search-input {
  flex: 1;
  min-width: 200px;
  padding: 8px 12px;
  font-size: 14px;
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  background: #fff;
}

.search-input:focus {
  outline: none;
  border-color: #0070f3;
}

.industry-tabs {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.tab {
  padding: 6px 12px;
  border: 1px solid #e0e0e0;
  border-radius: 16px;
  background: #fff;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s;
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
  margin-left: 3px;
}

.sites-table {
  border: 1px solid #e8e8e8;
  border-radius: 8px;
  overflow: hidden;
}

.table-header {
  display: grid;
  grid-template-columns: 160px 80px 2fr 2.5fr;
  gap: 16px;
  padding: 12px 20px;
  background: #f5f5f5;
  font-weight: 600;
  font-size: 13px;
  color: #666;
}

.table-row {
  border-top: 1px solid #f0f0f0;
  cursor: pointer;
}

.table-row:hover {
  background: #fafafa;
}

.table-row.expanded {
  background: #f8f9fa;
}

.row-main {
  display: grid;
  grid-template-columns: 160px 80px 2fr 2.5fr;
  gap: 16px;
  padding: 12px 20px;
  align-items: center;
}

.col-site strong {
  display: block;
  font-size: 14px;
}

.col-site .domain {
  display: block;
  font-size: 11px;
  color: #888;
  margin-top: 2px;
}

.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  text-align: center;
}

.badge.news { background: #fef3c7; color: #92400e; }
.badge.social { background: #dbeafe; color: #1e40af; }
.badge.video { background: #fce7f3; color: #9d174d; }
.badge.ecommerce { background: #fee2e2; color: #991b1b; }
.badge.developer { background: #e0e7ff; color: #3730a3; }
.badge.finance { background: #d1fae5; color: #065f46; }
.badge.ai { background: #f3e8ff; color: #6b21a8; }
.badge.electron { background: #dcfce7; color: #166534; }
.badge.other { background: #f3f4f6; color: #374151; }

.col-commands {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.cmd-tag {
  display: inline-block;
  padding: 2px 6px;
  background: #e8e8e8;
  border-radius: 3px;
  font-size: 11px;
  font-family: monospace;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.col-commands .more {
  font-size: 11px;
  color: #888;
  padding: 2px 4px;
}

.col-desc {
  color: #666;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.row-details {
  padding: 12px 16px 16px;
  background: #fff;
  border-top: 1px solid #e8e8e8;
}

.command-item {
  display: block;
  padding: 12px 14px;
  margin-bottom: 10px;
  background: #f9f9f9;
  border-radius: 6px;
}

.command-item:last-child {
  margin-bottom: 0;
}

.cmd-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.cmd-full {
  font-size: 13px;
  background: #e8e8e8;
  padding: 4px 10px;
  border-radius: 4px;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}

.cmd-full:hover {
  background: #dcdcdc;
}

.cmd-desc {
  font-size: 13px;
  color: #555;
  flex: 1;
}

.cmd-meta {
  display: flex;
  gap: 20px;
  margin-top: 8px;
  flex-wrap: wrap;
  font-size: 12px;
}

.meta-line {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.meta-label {
  font-weight: 600;
  color: #666;
}

.arg-tag {
  padding: 2px 6px;
  background: #fef3c7;
  border-radius: 3px;
  font-size: 12px;
}

.col-tag {
  padding: 2px 6px;
  background: #dbeafe;
  border-radius: 3px;
  font-size: 12px;
  color: #1e40af;
}

.no-results {
  text-align: center;
  padding: 40px;
  color: #666;
}

@media (max-width: 900px) {
  .table-header {
    display: none;
  }
  .row-main {
    grid-template-columns: 1fr 1fr;
  }
  .col-desc {
    display: none;
  }
}
</style>
