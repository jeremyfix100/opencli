# Huodongxing Search List Pagination Design

**Date:** 2026-04-18

## Goal

Extend `opencli huodongxing crawl` to support collecting event URLs from Huodongxing **search list pages** that paginate via:

- `pi=<n>` (page index)
- `qs=<keyword>` (query string)

Example: `https://www.huodongxing.com/search?ps=12&pi=3&list=list&qs=AI`.

## Approach

- Treat `/search` as a paginated list URL (similar to `/events`), but using `pi` as the page parameter.
- Keep `/events` pagination using `page`.
- For keyword input (non-URL), generate a canonical search URL using `qs`, `pi=1`, `ps=12`, `list=list`.

## Stop Conditions

Same as `/events` list collection:

- stop when `--limit` reached, or
- stop when 2 consecutive pages yield no new event URLs, or
- stop when a page/time safety cap is reached

## Testing

Add a unit test that:

- starts from a `/search?...&pi=3...` URL
- expects the crawler to visit `pi=3` and `pi=4`
- verifies it returns two extracted rows from two event detail pages

