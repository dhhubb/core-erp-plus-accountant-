# P2-01 — Rate limiting on the SaaS endpoints (Upstash Redis)

## Scope

Add rate limiting to the Phase 1 API endpoints using Upstash Redis. This is a Phase 2 item that was
explicitly out of scope for Phase 1.

## Preconditions

* All Phase 1 gates pass (see `docs/phase2/README.md`).
* An Upstash Redis database exists and its REST URL and token are provided as environment
  variables: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`. No Upstash account was needed in
  Phase 1; the human supplies these before the run.
* If the secrets are absent, the run must fail closed with a clear startup error rather than
  silently allowing unlimited traffic. Do not add an "if no config, skip limiting" escape hatch.

## Decisions

* Rate limiting lives in middleware around the route handlers, not inside the SQL functions. The
  ledger stays unaware of it.
* Key the limiter by **organisation** when a verified `org_id` claim is present, and by client IP
  otherwise. A single tenant cannot exhaust another tenant's budget.
* Use a sliding-window algorithm. Fixed windows allow a double burst across the boundary.
* Limits are configuration, not constants in code: read them from `settings` per org, with a
  documented default (for example 600 requests/minute/org) when the org has no override.
* Return `429` with `Retry-After` and a JSON body matching the existing error shape
  (`{"error": "..."}`) so clients see a consistent contract.

## Requirements

1. A reusable limiter module under `src/core/` (for example `src/core/rate-limit.ts`) with no `any`.
2. Middleware applied to every route under `src/app/api/**`. Health/readiness probes, if any, are
   exempt and the exemption is explicit in code.
3. The limiter is a no-op only when the request is already rejected by auth (no token → `401`, not
   `429`). Auth is checked first; rate limiting never masks an authentication failure.
4. Per-org limits are read through the same settings path as P2-04, but the limiter must not depend
   on P2-04 landing first. If P2-04 is not yet merged, read `settings` directly.
5. A structured log line on every rejection: org, route, limit, window, and current count. No PII.

## Milestones and gates

**M1 — limiter module and middleware.**
Gate: tests 41–42 pass, `npm run build` passes, `npm run lint` passes.

**M2 — per-org configuration and observability.**
Gate: tests 43–44 pass, build and lint pass, `PROGRESS.md` updated, commit.

## Tests (41–44)

41. Requests under the limit succeed; the request that crosses the limit gets `429` with
    `Retry-After`.
42. A `429` is not returned for a request that is already unauthenticated; that request gets `401`.
43. Two different orgs have independent budgets: exhausting org A does not limit org B.
44. An org-level override in `settings` takes effect on the next request (no restart).

Tests run against the real stack. Upstash is an external service: if it cannot be reached in CI,
the test must skip **with an explicit reason and a visible skip line**, not silently pass. Record
the skip policy in `PROGRESS.md`.

## Out of scope

* Redis for anything other than rate limiting (no caching, no queues, no pub/sub).
* Global/IP-based WAF rules or DDoS protection.
* Rate limiting the database directly (that is connection pooling's job).

## Deliverables

* `src/core/rate-limit.ts` and middleware wiring.
* `tests/rate-limit.test.ts` (tests 41–44).
* An ADR entry recording the algorithm, the key, and the default limit.
* `PROGRESS.md` section with the gate output.

## Open items

* Confirm the default per-org limit with the product owner. Record the number and its rationale in
  the ADR.
