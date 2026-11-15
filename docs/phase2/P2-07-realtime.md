# P2-07 — Realtime (Supabase Realtime, subscriptions scoped to the current branch)

## Scope

Add Supabase Realtime so the client can subscribe to changes, with **subscriptions scoped to the
current branch**. A user must never receive events for a branch they are not in.

## Preconditions

* All Phase 1 gates pass (see `docs/phase2/README.md`).
* Branch membership is carried in the JWT (`branch_ids`) by the Phase 1 custom access token hook.
* `[realtime]` is present in `supabase/config.toml`; confirm it is enabled and that the publication
  includes only the tables you intend.

## Decisions

* **Scope is enforced by Realtime authorization (RLS on `realtime.messages`), not by the client.**
  A client that subscribes to a branch it cannot access must receive nothing. Trusting the client to
  filter is a leak.
* Realtime exposes **only** the tables that need live updates. Do not add the whole ledger to the
  publication. Candidate set for this prompt: `invoices`, `stock_balances` (and `dashboard_stats` if
  P2-06 has landed). Immutable ledger tables (`journals`, `journal_lines`, `stock_ledger`) are poor
  realtime candidates and are excluded by default.
* Because `stock_balances` is a mutable cache, realtime on it is fine. Realtime on an immutable table
  is mostly append noise; justify any addition explicitly.
* Subscriptions are scoped by branch: the client subscribes to a topic per branch, and the Realtime
  authorization policy checks `branch_id = any(branch_ids from JWT)`.
* Realtime is **not** the source of truth. If a client misses an event, a normal refetch must
  reconcile it. Say this in the README.

## Requirements

1. Migration(s) enabling the needed tables in the Realtime publication and adding the authorization
   policy on `realtime.messages`.
2. A small client helper (for example `src/core/realtime.ts`) that subscribes to the current branch
   using the token's claims. No `any`.
3. Document in `README.md`: which tables stream, how the branch scope is enforced, and the
   refetch-on-miss contract.
4. No service-role key on the client. The subscription uses the user's token.

## Milestones and gates

**M1 — publication and authorization policy.**
Gate: tests 59–60 pass, build and lint pass.

**M2 — client helper and docs.**
Gate: test 61 passes, build and lint pass, `README.md` updated, `PROGRESS.md` updated, commit.

## Tests (59–61)

59. A user with access to branch A receives an event for a change in branch A.
60. A user **without** access to branch B receives nothing for a change in branch B (this is the
    security test; it must fail if the authorization policy is removed).
61. The excluded immutable tables are not in the publication (assert on `pg_publication_tables`).

Tests that depend on live websockets may be slow or flaky in CI. If so, keep the authorization
assertions as SQL-level tests (policy present and correct) and mark the end-to-end websocket test as
an explicit, visible skip with a reason. Never silently pass. Record the policy in `PROGRESS.md`.

## Out of scope

* Presence, broadcast (non-database) channels, or typing indicators.
* Realtime on ledger/immutable tables.
* Offline sync or conflict resolution.

## Deliverables

* Migration(s) for the publication and `realtime.messages` policy.
* `src/core/realtime.ts`.
* `tests/realtime.test.ts` (tests 59–61).
* `README.md` realtime section.
* `PROGRESS.md` section with the gate output.

## Open items

* Confirm the exact table set the product wants live. This prompt assumes `invoices` and
  `stock_balances`.
