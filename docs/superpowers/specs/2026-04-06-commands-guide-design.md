# 功能指南设计文档

**日期**: 2026-04-06

## 概述

为 OpenCLI 项目创建一个功能指南页面，可视化展示：
- 支持的站点列表
- 每个站点的命令行
- 命令行爬取的数据结构

## 需求

1. 站点列表 + 搜索过滤
2. 按地区分类：中文站点 / 英文站点 / Electron App
3. 每个站点的命令详情（参数、输出字段）
4. 数据来源：`cli-manifest.json` 动态生成

## 技术方案

### 1. 数据生成
- 脚本：`scripts/generate-commands.ts`
- 输入：`cli-manifest.json`（1000+ 命令，58 个站点）
- 输出：`docs/.vitepress/data/commands.json`
- 运行：`npm run docs:commands`

### 2. 页面实现
- 路径：`docs/guide/commands.md`
- 框架：VitePress + Vue 3
- 组件：
  - `CommandsExplorer.vue` - 主组件
  - 搜索框
  - 分类 Tabs
  - 站点卡片列表
  - 命令详情展开面板

### 3. 分类规则
- **中文站点**：domain 包含 `.cn` 或站点名含中文
- **英文站点**：其他非中文站点
- **Electron App**：domain 为 `localhost`

### 4. 站点数据结构
```json
{
  "site": "bilibili",
  "category": "cn",  // "cn" | "en" | "electron"
  "commands": [
    {
      "name": "hot",
      "description": "B站热门视频",
      "args": [{ "name": "limit", "type": "int", "default": 20 }],
      "columns": ["rank", "title", "url", "cover"]
    }
  ]
}
```

## 页面交互

1. 页面加载显示所有站点卡片（摘要模式）
2. 搜索框实时过滤站点/命令
3. Tab 切换分类
4. 点击站点卡片展开命令列表
5. 每个命令显示：命令格式、参数、输出字段

## 入口配置

在 `docs/.vitepress/config.mts` 的 sidebar 添加：
```ts
{ text: 'Commands', link: '/guide/commands' }
```

## 待办

- [ ] 创建数据生成脚本
- [ ] 创建 Vue 组件
- [ ] 创建页面 Markdown
- [ ] 配置 sidebar
- [ ] 测试构建
