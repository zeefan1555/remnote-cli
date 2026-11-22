# Pagination

`search`, `search-by-tag` and single-parent `list-children` support automatic
cursor pagination.

## Complete snapshots

```bash
remnote-cli rem search "project plan" --all
remnote-cli rem search-by-tag --tag-id TAG_ID --all
remnote-cli rem children list PARENT_ID --all
```

`--all` follows every page by default. It does not impose a hidden page or item
limit.

## Explicit bounds

```bash
remnote-cli rem search "project plan" --all --max-pages 20 --page-delay 100
```

`--max-pages` is an operator-selected safety bound and requires `--all`.
`--page-delay` is the number of milliseconds to wait between page requests.

## Result metadata

Every paged response contains:

```json
{
  "paging": {
    "complete": true,
    "pages": 3,
    "itemCount": 120
  }
}
```

An incomplete result also contains `nextCursor` and keeps `hasMore=true`.

## Cursor safety

Each next request reuses the original query and scope and changes only the cursor.
Pagination fails as a conflict when:

- `hasMore=true` has no next cursor
- the next cursor is empty
- a cursor is repeated
- the response is missing its expected result array

The raw one-page mode also reports `paging.complete`. Reuse `--cursor` with
the same query and scope to continue manually.

Several-parent `list-children` keeps its raw multi-result shape because each parent
has an independent cursor.
