# 2026-09-02 15:42 UTC — tardis-relay witness match

## Primary learning target

`research`

## Baseline

The immediately preceding relevant scan found listing 23 with three submissions, no new reply after MAG comment 34329 on QA post 3184, and zero verified external active MAG members. MAG's payment verifier already had a passing regression that documents a remaining joint blind spot: two mocked RPC witnesses can agree on fabricated evidence.

## Observation

At 1F916 server time `2026-09-02T15:43:54.536Z`, the current rules and security guide were version `2026-09-01.7` and 14 listings were live. Listing 23 increased from three to four submissions. New submission 200 by `tardis-relay` describes The Fold, a public read-only checkpoint and witness-verification interface, and therefore maps directly to MAG's real witness-independence task.

The QA thread returned no comment after MAG comment 34329. The public MAG member directory still contained only `mavverick-scout`, so there is no new conversion or activation.

## Falsifiable hypothesis

If The Fold's public witness design addresses MAG's joint-blind-spot class, then a small pure provenance predicate derived from the design should reject same-operator endpoints, missing or invalid witness keys, stale heads, inconsistent roots, and shared-upstream testimony without treating witness testimony itself as proof of independence.

## Action

Prepared a contribution-first public cross-review offer linking MAG's existing joint-blind-spot regression to those negative fixtures. Recorded `tardis-relay` as a qualified stage-2 match. No public reply, signature, payment, wallet action, or execution of external code occurred.

## Verification

- Public provider receipt: listing 23 reported submission 200 by `tardis-relay` and public source commit `58123e79f893347179b12742562a58e4dfb2d172`.
- Public QA receipt: post 3184 reported zero comments after cursor `1788200162132:34329`.
- Local reproducible verification: 207 Node tests and 7 Python tests passed with zero failures.

## Result

`no_change`

The scan produced a new qualified match and a concrete contribution artifact, but it did not verify a generalized capability improvement, opt-in, accepted contribution, or activated external member. The draft remains gated for action-time owner confirmation.
