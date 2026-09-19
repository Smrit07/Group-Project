# Database

MySQL 8 (or MariaDB 10.4+, which is what XAMPP actually ships). All three files
run from phpMyAdmin's SQL tab or the `mysql` client.

## Which file to run

**Fresh install** — run these two, in order:

1. `schema.sql` — creates the `smart_cafeteria` database, every table and both
   reporting views.
2. `seed.sql` — demo accounts, counters, menu, and 14 days of operational
   history.

**Upgrading an existing database** built from an earlier version of
`schema.sql` — run `migration_2026_10_des.sql` instead. It adds the new columns,
the `service_events` table and the views without touching your data, and it is
safe to run more than once (each change is guarded by an
`information_schema` check).

```
mysql -u root < schema.sql
mysql -u root < seed.sql
```

XAMPP's default is user `root` with an empty password, so no `-p` is needed
unless you set one.

## Tables

| Table | Purpose | Report reference |
|---|---|---|
| `users` | student / staff / manager / admin | FR-01, NFR-05 |
| `menu_items` | what students can order | FR-05, FR-06 |
| `counters` | physical serving points, open/closed, assigned staff | FR-05, FR-11, NFR-10 |
| `orders` | pre-orders and their lifecycle timestamps | FR-06 – FR-10 |
| `order_items` | line items | — |
| `queue_observations` | periodic queue/wait snapshots | FR-02, FR-13, FR-14 |
| `simulation_scenarios` | stored what-if runs and their results | FR-12, FR-13 |
| `service_events` | measured service times — the DES calibration sample | Section 7.1 |

## Views

`v_peak_hour_performance` — orders, pre-order share and average fulfilment time
per hour per day.

`v_prediction_accuracy` — the wait estimate shown when an order was placed,
against how long that order actually took. "Prediction accuracy" is named as an
evaluation metric in Section 6.3 of the proposal but previously had nothing
behind it; this is what supplies the number.

Both views are aggregates with no `student_id` column at all. FR-17 and NFR-06
require administrators to see summarised figures only, and enforcing that in
the view rather than in each controller means the rule still holds if a future
endpoint forgets it.

## Design decisions worth defending

**Four nullable timestamp columns on `orders`, not one `updated_at`.**
`updated_at` is overwritten at every status change, so by the time an order is
completed the moment it entered preparation is gone — and that interval is
exactly what the DES model calibrates its service times against.

**`service_events` is a separate table, not a query over `orders`.** The
manually timed observations from Sprint 1 have no order row at all and still
belong in the calibration sample. The fit also reads this table on a hot path,
where one narrow indexed table beats a join across the whole order history.

**`counters.service_profile`.** The thali counter is slower than the tea
counter, and a dedicated pickup point is faster than both. Averaging them into
one service-time distribution would hide exactly the difference a manager would
act on.

## About the seed data

The 14 days of history in `seed.sql` are **generated, not measured**. Every
`service_events` row carries `source = 'simulated'`, so it cannot be mistaken
for real cafeteria readings.

It exists because a dashboard with no history looks broken, and the DES
calibration has nothing to fit against on a fresh install. Delete everything
below the `PART 2` banner for a clean database, or set
`DES_USE_DB_CALIBRATION=false` in `des-engine/.env` to have the model ignore it
and use the documented defaults instead.

The password for every demo account is `Password123!`. These are bcrypt hashes
generated for local testing — replace them before any real deployment.
