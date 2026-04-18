# Huodongxing Events List Pagination Design

**Date:** 2026-04-18

## Goal

Extend `opencli huodongxing crawl` to support collecting event detail URLs from Huodongxing **events list pages** that paginate via `?page=<n>` (e.g. `/events?...&page=33`), then crawl each event detail page using the existing schema-first extraction path.

## Non-Goals

- Do not change the existing event detail extraction pipeline (`core_schema`, `selector_plan`, artifacts layout).
- Do not implement DOM-based clicking of pagination controls unless `?page=` is insufficient.

## Approach

### List URL detection

If `query_or_url` is a full URL and its pathname contains `/events`, treat it as an “events list” and enable pagination. Otherwise:

- keyword input continues to use `/search?wd=<keyword>` (existing behavior)
- direct `/search` URL remains supported (single-page best-effort; pagination is not added unless later requested)

### Pagination strategy (URL-based)

Pagination is performed by rewriting the list URL’s query parameter:

- `page` param is set to `1, 2, 3...` (or starting from the provided `page` value)
- preserve all other query parameters (e.g. `orderby`, `d`, `city`)

### Collection loop

The list collector loops over pages and extracts anchor URLs that contain `/event/`:

- Maintain `seenUrlKeys` to dedupe across pages
- Append new items until `--limit` reached
- Stop early when:
  - `--limit` reached, or
  - consecutive pages with no new items exceed a small threshold (e.g. 2), or
  - a hard cap of pages is reached (prevents runaway loops)

### Error handling

- If auth/captcha is detected and no targets were collected, raise `AuthRequiredError` (existing behavior).
- If no targets are collected at all, raise `EmptyResultError` (existing behavior).

## Testing

Add a unit test that simulates:

- list page `page=1` returns 1 event URL
- list page `page=2` returns a second event URL
- crawl proceeds to detail extraction for both URLs

The test asserts returned rows length and that `page.goto` was called with list URLs for multiple `page` values.

