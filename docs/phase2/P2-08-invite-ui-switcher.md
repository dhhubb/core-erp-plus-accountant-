# P2-08 — Invite UI and org/branch switcher

## Scope

Two pieces of UI on top of the Phase 1 backend: an **invite flow** (create and accept an invite) and
an **org/branch switcher** that changes which org/branch the user is acting in.

## Preconditions

* All Phase 1 gates pass (see `docs/phase2/README.md`).
* Phase 1 already has the invite backend: `invites` stores only a **hash** of the token, the token is
  **single use**, and it **expires after 72 hours**. This prompt does not change that backend.
* The auth hook puts `org_id` and `branch_ids` in the JWT. **Membership changes take effect on token
  refresh, not before** — the switcher must live with that (see below).

## The token-refresh constraint

The switcher cannot make new access appear instantly: claims only change when the token refreshes.
The UI must therefore:

* After a switch, **force a token refresh** before showing the new scope's data.
* If a user was just added to a branch, show a clear "your access updates when your session
  refreshes" message rather than a confusing empty state.

This is a UX requirement, not just a backend one. Test it.

## Decisions

* The invite UI calls the existing Phase 1 invite functions/endpoints. Do not re-implement hashing or
  expiry in TypeScript.
* The accept-invite page is public (unauthenticated) and only needs the token from the URL. It must
  not echo the token back in logs or in the page HTML beyond what is needed to submit it.
* Switching org/branch updates the active selection server-side (a cookie or a profile field) **and**
  refreshes the token, because the JWT is what RLS reads.
* The switcher only lists orgs/branches the user actually belongs to.

## Requirements

1. `createInvite` UI (authenticated, org-admin only) and `acceptInvite` page (public).
2. An org/branch switcher component wired to a server action or route that updates the active scope
   and refreshes the session token.
3. Loading and error states for every async action. No infinite spinners.
4. Accessible markup (labels, focus order, keyboard operable). This is the first real UI; set the bar.

## Milestones and gates

**M1 — invite create + accept.**
Gate: tests 62–63 pass, build and lint pass.

**M2 — switcher and token refresh.**
Gate: test 64 passes, build and lint pass, `PROGRESS.md` updated, commit.

## Tests (62–64)

62. Creating an invite shows the one-time link; the raw token is never stored (assert the `invites`
    row holds a hash and not the token).
63. Accepting an invite once succeeds and a second use fails; an expired invite fails. (This exercises
    the Phase 1 backend through the new UI path.)
64. Switching org/branch changes the effective scope only after a token refresh: before the refresh
    the old scope is still enforced; after it, the new scope is.

## Out of scope

* Roles and permissions beyond org-admin for invites.
* Bulk invites, invite reminders, or email delivery (the link is shown/copied, not sent).
* Any change to the Phase 1 invite token, hashing, or expiry semantics.

## Deliverables

* Invite UI pages and the switcher component.
* `tests/invite-ui.test.ts` (tests 62–64).
* `README.md` note restating that membership changes apply on token refresh.
* `PROGRESS.md` section with the gate output.

## Open items

* Confirm whether invites are emailed or just link-shared in this phase. This prompt assumes
  link-shared (no email provider in scope).
