# Greenfield Foundations — decide these before building features

Some decisions are cheap on day zero and brutally expensive to retrofit once there is
production data, real users, or pages built on top of them. This is the checklist of those
decisions. Run `/foundation` at the start of a new project to work through them and record
the answers.

## The test

For any decision, ask: **"If we already had 10,000 rows and 500 users, how painful would
adding this be?"** If the answer is *migration hell* or *touch every file*, it's a
foundation decision — make it now, with the end in mind. The organizing rule: **decide
first the things that touch every row, every request, every page, or every user.**

Model the whole domain before building features on a slice of it. The named entities
(orders, customers, suppliers…) are the easy part — the cross-cutting concerns below
(tenancy, money, time, identity, audit) are just as structural but easy to forget because
they aren't "things."

---

## Tier 1 — Touch every row (worst to retrofit)

- [ ] **Base data model, end-in-mind.** Enumerate the core entities up front — orders,
      customers, clients, suppliers, products, whatever the domain needs — and model them at
      the root, then build features around them. A feature built on a half-modeled domain
      calcifies the gaps.
- [ ] **Multi-tenancy — isolation, not just a column.** If the app is multi-organization,
      put `org_id` (or `tenant_id`) on every tenant-scoped row **and** enforce isolation at
      the database layer (e.g. Supabase RLS keyed on the tenant), not in app code. One
      missed `WHERE` clause leaks tenant A's data to tenant B.
- [ ] **Multi-user.** If more than one user shares data, build it first. Retrofitting
      user-scoping onto single-user tables rewrites every query.
- [ ] **Money = integer minor units + explicit currency code.** Store `1234` + `"AUD"`,
      never `12.34` as a float. Retrofitting after financial rows exist means re-migrating
      every row and re-deriving every total.
- [ ] **Timestamps: UTC + `created_at`/`updated_at` on every table.** Decide the timezone
      convention once, before the first table. Store UTC; convert at the edges. (Mixed
      conventions are among the nastiest bugs to unwind.)
- [ ] **Soft deletes + audit trail.** `deleted_at` and/or history rows from the start. You
      cannot reconstruct history you never recorded.
- [ ] **Primary-key strategy.** UUIDs vs sequential integers. Sequential keys leak record
      counts and complicate multi-tenant merges. Decide before anything references a key.
- [ ] **Migrations discipline.** Every schema change is a versioned, checked-in migration
      from commit #1 — never a manual dashboard edit. Otherwise environments drift and
      neither is reproducible.

## Tier 2 — Touch every user / request

- [ ] **Authentication (identity).** Separate from permissions. Decide the identity
      provider, session model, and whether SSO is on the horizon — bolting SSO on later can
      force a user-model rewrite.
- [ ] **Authorization (permissions).** Spec the permission model at the beginning so it's
      threaded through every route and view from day one, not sprinkled in later. Roles,
      per-resource checks, admin escape hatch.
- [ ] **PII / privacy.** Know which fields are personal data and build data-export and
      data-delete paths early. "Give me my data / delete me" is schema-shaped and often
      legally required — auditing for PII after the fact is far harder.

## Tier 3 — Touch every page / render

- [ ] **Caching strategy.** This changes how every page load and data delivery works —
      decide it early: what's cached, where (edge / server / client), how it's invalidated,
      and what "stale" means. A cache-writer must throw on a missing dependency, never cache
      an empty success as fact.
- [ ] **Theming.** A theme/token file plus reusable components from day one. Retrofitting a
      theme means touching every component; a token layer makes dark mode / rebrand / white-
      label a config change.
- [ ] **Internationalization.** Route all user-facing strings through a translation file
      even if you launch in one language — adding a second language later is then data, not
      a refactor of every component.
- [ ] **Feature flags.** Decouple deploy from release so you can ship dark, roll out per
      tenant, and kill a bad feature without a revert. Nearly free early; a refactor to add
      once everything ships on merge.

## Tier 4 — Operational spine

- [ ] **Environments & secrets.** dev / staging / prod separation and an env-var strategy
      decided before the first secret is hardcoded.
- [ ] **Observability.** Error tracking, structured logging, and a product-analytics event
      schema from day one — you can't analyze events you never instrumented.
- [ ] **Background jobs / queues / cron.** Where async work runs and how it's scheduled.
- [ ] **File / media storage + CDN.** Where uploads live and how they're served.
- [ ] **Transactional email / notifications.** The channel for password resets, receipts,
      alerts.
- [ ] **Testing + CI baseline.** A test runner and a CI pipeline wired before the codebase
      is big enough to make adding them a chore.
- [ ] **Backups / disaster recovery.** Confirm the datastore is actually backed up and that
      restore has been tested at least once.

---

## How to use this

`/foundation` walks these interactively at project start, records the decisions in
`.claude/reference/foundations.md` (the living record of *what was decided and why*), and —
where it makes sense — seeds the initial data model and the CLAUDE.md conventions from the
answers. Not every project needs every row: skip what doesn't apply, but skip it
*deliberately*, on the record, rather than by omission.

## The greenfield flow

`/foundation` → spec each feature (`/spec`) → **`/distill`** → build.

`/distill` (Christopher Alexander) is the holistic reductive pass over the *whole plan* — simplify,
consolidate the same need spread across specs, and extract recurring shapes into one reusable module
instead of three hand-rolled ones. Run it **once the feature set is substantially all spec'd and
stable, before writing feature code** — the cheapest moment to make three specs share a component.
It's optional and greenfield-only: a small project with a handful of specs has nothing to consolidate.
`/distill` proposes edits you approve (never auto-rewrites) and never touches this `foundations.md`
record — foundation-layer changes route back through `/foundation`.
