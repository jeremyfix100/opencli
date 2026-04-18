# Huodongxing Events List Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support list pagination for Huodongxing `/events` pages (`?page=<n>`) and `/search` pages (`?pi=<n>`) in `opencli huodongxing crawl`.

**Architecture:** Add a small list-collection loop that rewrites the list URL’s paging query parameter (`page` for `/events`, `pi` for `/search`) while preserving other filters, dedupes event URLs across pages, and stops when `--limit` is satisfied or progress stalls.

**Tech Stack:** TypeScript, `@jackwener/opencli` CLI registry, mocked `IPage` for tests (`vitest`).

---

### Task 1: Add URL pagination helpers

**Files:**
- Modify: `opencli/clis/huodongxing/crawl.ts:1`
- Test: `opencli/clis/huodongxing/crawl.test.ts:1`

- [ ] **Step 1: Write a failing test for list pagination URL rewriting**

Add a test that expects list collection to call `page.goto` for `page=1` then `page=2` when crawling an `/events?...&page=1` URL with `limit=2`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd opencli && npm test -- clis/huodongxing/crawl.test.ts`

Expected: FAIL because the implementation only extracts from the first list page.

- [ ] **Step 3: Implement helpers**

Add these helpers in `opencli/clis/huodongxing/crawl.ts`:

```ts
function isEventsListUrl(url: string): boolean
function getPageNumberFromUrl(url: string): number
function withListPageNumber(url: string, pageNo: number): string
```

- [ ] **Step 4: Re-run the test**

Run: `cd opencli && npm test -- clis/huodongxing/crawl.test.ts`

Expected: still FAIL (helpers alone don’t change behavior yet).

### Task 2: Implement list-collection loop over `?page=`

**Files:**
- Modify: `opencli/clis/huodongxing/crawl.ts:1`
- Test: `opencli/clis/huodongxing/crawl.test.ts:1`

- [ ] **Step 1: Implement `evalHuodongxingList(page, limit)`**

Extract current inline list `page.evaluate` into a helper that returns:

```ts
type HuodongxingListEvalPayload = { authRequired?: boolean; items?: Array<Record<string, unknown>>; itemCount?: number };
```

- [ ] **Step 2: Replace single-page list scrape with pagination collection**

In `func`:

- detect `/events` URLs
- detect `/search` URLs
- collect across pages into `targets` until `limit` reached
- stop when no new items for 2 pages or hard page cap reached

- [ ] **Step 3: Make the pagination test pass**

Adjust mock `createPage([...])` results sequence if needed.

- [ ] **Step 4: Run the full `opencli` tests**

Run: `cd opencli && npm test`

Expected: PASS
