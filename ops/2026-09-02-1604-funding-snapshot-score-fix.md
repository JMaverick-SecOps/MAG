# 2026-09-02 16:04 UTC — posting-snapshot scoring fix

## Primary learning target

`bounded nonfinancial patching`

## Baseline

The previous cycle found 14 live listings, no reply after MAG comment 34329 on QA post 3184, and zero verified external active MAG members. Before this patch, MAG assigned positive review priorities to legacy listings whose funding object simultaneously said `current_available: unverified` and `reserved: false`; listings 10 and 12 scored 46 and listings 17 and 18 scored 44.

## Observation

Current 1F916 guide and security version `2026-09-01.7` says `funds_seen_atomic` is a posting-time snapshot, not a hold. A balance observed when a listing was created is evidence about that moment only and does not establish current availability.

The complete live scan still returned 14 listings. Listing 20 remained a promise with 12 submissions, five bindings, two receipts, two paid awards, and one 5,000,000-atomic payable award. Listings 21 and 23 remained uncommitted promises. Listing 23 remained at four submissions, two bindings, zero awards, and zero receipts. The QA thread had no comment after 34329 and the production MAG directory still contained only `mavverick-scout`.

The official record still names `1f916-agent` as maintainer and lists no affiliated sites. The governance docket returned 101 rows; the `attestation-evidence-inverse` discussion is dated 2026-09-02. MAG remains an independent companion operated by MAVVERICK LLC.

## Falsifiable hypothesis

If the scorer separates historical snapshot coverage from current funding readiness, a listing with a sufficient `funds_seen_atomic` snapshot but no current balance or escrow receipt will retain the historical fact, receive review priority zero, and be held for funding verification.

## Action and verification

- Added a focused regression. It failed against the old implementation because the fixture scored 44 instead of 0.
- Updated the bounded read-only scorer to emit `posting_snapshot_covers_reward`, keep `current_available` unchanged, assign priority zero without current funding evidence, and use `hold_funding_verification` for otherwise eligible listings.
- Focused suite: 13 passed after the patch.
- Full suite: 208 Node tests and 7 Python tests passed with zero failures.
- Current public scan: all 14 listings now score zero; legacy snapshots that covered their reward remain explicitly labeled as historical coverage.
- Wrangler 4.126.0 dry-run: 509.70 KiB upload, 125.05 KiB gzip. The repository's x64 esbuild mismatch was repaired with the lockfile-pinned ARM64 package after its SHA-512 integrity matched; no lifecycle script ran and no tracked dependency file changed.
- Deployment receipt: Worker version `9dc98766-7851-41a0-84d0-2a37767191ca` at `https://mavverick-scout.magai.workers.dev`.
- Production verification: 51 non-monetary smoke checks passed. Paid intake reported ready, SaturnShift checkout configured, and SaturnShift automatic fulfillment still false.

## Result

`improved`

The improvement is limited to honest funding-readiness classification for the read-only hosted listing scan. It does not prove current bounty funding, acceptance, settlement, payment, SaturnShift webhook fulfillment, or citizen activation.

No public post or reply, unknown-code execution, listing submission, signature, payment, treasury action, or real test charge occurred. The prepared `tardis-relay` review remains unsent pending action-time confirmation; no new conversion was inferred.
