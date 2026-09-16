# Database

`schema.sql` — creates the `smart_cafeteria` database and all tables:
`users`, `menu_items`, `counters`, `orders`, `order_items`, `queue_observations`,
`simulation_scenarios`. See Section 5.1 of the group report for the entity-relationship
rationale.

`seed.sql` — sample menu items, counters, and one demo user per role (student, staff,
manager, admin), all with the password `Password123!`, for local development and the demo.

## Apply locally (XAMPP MySQL)

```
mysql -u root -p < schema.sql
mysql -u root -p < seed.sql
```

Or paste the contents into phpMyAdmin's SQL tab at http://localhost/phpmyadmin.
