# jobspy-scanner

A timer-triggered Python Function App that scrapes job boards with
[python-jobspy](https://github.com/speedyapply/JobSpy) and hands the postings to the
Node app's `collect` function. It is its own app because one Flex Consumption app
runs one language. Plan: the wiki's Jobspy Plan.

## What it does

1. Reads `config.toml` (the blob the Node app reads): `target_titles` and `locations`
   give the searches, one per title and place. An optional `[jobspy]` table tunes the
   scrape (all keys optional):

   | key | default | |
   |---|---|---|
   | `enabled` | `true` | `false` hands over nothing |
   | `titles` | `target_titles` | narrows the titles searched |
   | `sites` | indeed, linkedin, glassdoor, zip_recruiter | also `google` |
   | `results_wanted` | 15 | per site per search |
   | `hours_old` | 48 | |
   | `concurrency` | 2 | searches at once |
   | `country_indeed` | `USA` | |
   | `fetch_descriptions` | `true` | LinkedIn's description needs a request per row |

   The Node app's config schema is strict, so the `[jobspy]` table can be added to the
   real config only once the Node side knows it (a later step). Until then the scan
   runs on the defaults.
2. Maps each row to a posting in code. There is no model call. A posting's
   `requirements` are the description's own lines (HTML turned into plain text, one line per block, at most 40, each
   at most 300 characters), since the judge reads requirements and nothing else of the
   description.
3. Writes `<day>/jobspy/<started-at>-<random>.json` to the `postings` container and
   sends one message on `postings-ready`. Both formats are the Node side's
   (`functions/src/lib/run/handoff.ts`); `tests/fixtures` holds a sample of each that
   the Node tests read too.

A failed or empty search is a warning in the file, never an error. A scan that fails
altogether still writes an empty file before it fails, so the day's report runs on the
mail alone instead of waiting out `collect`'s deadline. Logs hold counts and error
names only, never what a posting says.

## App settings

`CONFIG_BLOB_URL`, `POSTINGS_URL`, `POSTINGS_QUEUE_URL`, plus the identity's access
to them (infrastructure is a separate step).

## Develop

```bash
python3.12 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
python -m pytest -q
ruff check --select E4,E7,E9,F .
```

Tests fake `scrape_jobs` and the Azure clients at their boundaries; nothing scrapes.
