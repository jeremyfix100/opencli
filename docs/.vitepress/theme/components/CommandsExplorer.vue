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
            
            <div v-if="cmd.args && cmd.args.length" class="command-args">
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
            
            <div v-if="cmd.columns && cmd.columns.length" class="command-columns">
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
import commandsData from '../../../.vitepress/data/commands.json';

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
