# P2-04 — Settings cache (Next.js `unstable_cache`, invalidated on every settings write)

## Scope

Cache org settings reads with Next.js `unstable_cache`, and invalidate the cache on **every** settings
write. This is a read-path optimisation only.

## Preconditions

* All Phase 1 gates pass (see `docs/phase2/README.md`).
* `public.settings` exists, one row per org (`org_id` is unique), with `rounding_account_code`,
  `base_currency`, and `allow_negative_stock`. Posting reads `rounding_account_code` from here.

## The one rule that matters

**Tax and rounding settings must not sit in a 10-minute stale cache.** The backlog says so
explicitly, and it is the reason this item is risky:

* Posting (`post_journal`) reads the rounding account **from the database inside its own
  transaction**. That must not change. The cache is for *read* paths (rendering, validation,
  dashboards), never for posting.
* If a settings write changes `rounding_account_code`, the next posting must use the new value
  immediately. The cache must never be consulted on the posting path, so this is guaranteed by
  construction rather than by a short TTL.
* Do not set a long TTL and hope invalidation covers it. Use a short TTL **and** explicit
  invalidation, and make the posting path provably independent of the cache (a test asserts it).

## Decisions

* Tag every cached settings entry per org: `settings:${orgId}`. Invalidate that tag on every write.
* Every settings write goes through one function that writes the row and calls `revalidateTag` in the
  same code path. There is exactly one write path; no ad-hoc updates elsewhere.
* TTL is short (for example 60 seconds) as a backstop. Invalidation is the primary mechanism; the TTL
  only bounds staleness if an invalidation is ever missed.
* Cache reads are allowed to be stale for display. They are never allowed to be stale for money.

## Requirements

1. `src/core/settings.ts` (or similar) exposing `getSettings(orgId)` (cached) and
   `updateSettings(orgId, patch)` (writes + invalidates). No `any`.
2. Confirm `post_journal` and all posting functions continue to read settings directly from the
   database in their transaction. If any Phase 1 code path accidentally routes through the cache,
   fix it and say so in `PROGRESS.md`.
3. A test that proves posting is unaffected by a stale cache: prime the cache, change
   `rounding_account_code`, and show the next posting uses the new value with no cache refresh
   required.
4. An ESLint guard (or an equivalent automated check) preventing `unstable_cache` from being imported
   into `src/accounting/**`.

## Milestones and gates

**M1 — cached reads and single write path.**
Gate: tests 51–52 pass, build and lint pass.

**M2 — posting-path independence and the stale-cache test.**
Gate: test 53 passes, build and lint pass, `PROGRESS.md` updated, commit.

## Tests (51–53)

51. A settings read is served from cache on the second call (assert no second database round trip, or
    assert the cached value is returned after the row is changed out-of-band).
52. A settings write invalidates the cache: the next read reflects the new value immediately.
53. Posting is immune to a stale cache: after changing `rounding_account_code` with the cache primed,
    the next journal posts its residual to the **new** rounding account.

## Out of scope

* Caching anything other than settings (no tax-rate cache, no exchange-rate cache in this prompt).
* Cache warming, background refresh, or cross-instance invalidation beyond Next.js tags.
* Changing how posting reads rounding/tax values.

## Deliverables

* `src/core/settings.ts` with cached read + invalidating write.
* The ESLint guard for `src/accounting/**`.
* `tests/settings-cache.test.ts` (tests 51–53).
* `PROGRESS.md` section with the gate output and a note that posting is cache-independent.

## Open items

* Confirm the TTL. Record it and the reasoning (short backstop, invalidation is primary) in the ADR.
