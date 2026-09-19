-- ===========================================================================
-- Smart Cafeteria — migration: DES calibration + order lifecycle timing
-- ===========================================================================
-- Run this ONLY if you already have a `smart_cafeteria` database created from
-- the original schema.sql.  A fresh install should just run schema.sql, which
-- already contains everything below.
--
-- In phpMyAdmin: select the smart_cafeteria database, open the SQL tab, paste
-- this file, click Go.  It is safe to run more than once.
--
-- Why this migration exists
-- -------------------------
-- Section 7.1 of the final report names the project's own weakest point: the
-- DES model was calibrated from a small hand-timed sample, so it predicts
-- badly on atypical days.  The system already watches every order go past —
-- it just wasn't writing down the timings.  These columns and tables record
-- them, which lets des-engine/des/calibration.py re-fit the model from real
-- operational data instead of from the clipboard readings taken in Sprint 1.
-- ===========================================================================

USE smart_cafeteria;

-- ---------------------------------------------------------------------------
-- 1. Order lifecycle timestamps
-- ---------------------------------------------------------------------------
-- `updated_at` alone is useless for measuring service time: it is overwritten
-- at every status change, so by the time an order is completed the moment it
-- became "preparing" is gone.  One nullable column per transition keeps the
-- whole history of an order on the order row itself.
--
-- MySQL 8 has no "ADD COLUMN IF NOT EXISTS", so each statement is wrapped in
-- a procedure that checks information_schema first.  That is what makes this
-- file safe to re-run.

DROP PROCEDURE IF EXISTS add_column_if_missing;
DELIMITER //
CREATE PROCEDURE add_column_if_missing(
  IN in_table  VARCHAR(64),
  IN in_column VARCHAR(64),
  IN in_definition TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = in_table
      AND COLUMN_NAME  = in_column
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', in_table, '` ADD COLUMN `', in_column, '` ', in_definition);
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL add_column_if_missing('orders', 'is_preorder',
  'BOOLEAN NOT NULL DEFAULT TRUE COMMENT ''FALSE = walk-in logged at the counter, TRUE = placed through the app''');
CALL add_column_if_missing('orders', 'preparing_at',
  'DATETIME NULL COMMENT ''when staff started preparing — start of service''');
CALL add_column_if_missing('orders', 'ready_at',
  'DATETIME NULL COMMENT ''when the order became collectable — end of preparation''');
CALL add_column_if_missing('orders', 'completed_at',
  'DATETIME NULL COMMENT ''when the student actually collected it''');
CALL add_column_if_missing('orders', 'total_amount',
  'DECIMAL(8,2) NULL COMMENT ''order value, denormalised for reporting''');

-- Open-counter count belongs alongside the queue length: an estimate of
-- "12 waiting" means nothing without knowing whether 1 or 4 counters were
-- serving them.  Without this, historical observations cannot be used to
-- validate the model afterwards.
CALL add_column_if_missing('queue_observations', 'open_counters',
  'INT NOT NULL DEFAULT 0 COMMENT ''counters serving at the moment of the snapshot''');
CALL add_column_if_missing('queue_observations', 'model_version',
  'VARCHAR(20) NULL COMMENT ''which DES model version produced the estimate''');

-- Counters differ: the thali counter is slower than the tea counter, and
-- averaging them into one service-time distribution hides exactly the
-- difference a manager would act on.
CALL add_column_if_missing('counters', 'service_profile',
  "ENUM('standard','fast','preorder_pickup') NOT NULL DEFAULT 'standard' COMMENT 'feeds per-counter service-time calibration'");

DROP PROCEDURE IF EXISTS add_column_if_missing;

-- ---------------------------------------------------------------------------
-- 2. service_events — the calibration table
-- ---------------------------------------------------------------------------
-- One row per completed service.  This is what the DES engine fits its
-- lognormal service-time distribution against.
--
-- It is kept separate from `orders` rather than being derived by subtracting
-- timestamps in a query, for two reasons:
--   * manually timed observations (the Sprint 1 stopwatch data) have no order
--     row at all, and they still need to be part of the calibration sample;
--   * the fit reads it on a hot path, and a narrow purpose-built table with
--     one index beats a five-way join over the whole order history.
CREATE TABLE IF NOT EXISTS service_events (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  order_id        INT NULL COMMENT 'NULL for manually timed observations',
  counter_id      INT NULL,
  is_pickup       BOOLEAN NOT NULL DEFAULT FALSE
                  COMMENT 'TRUE = collecting a pre-order (fast), FALSE = ordering at the counter',
  service_seconds DECIMAL(8,2) NOT NULL
                  COMMENT 'time at the counter, from start of service to walking away',
  queue_on_arrival INT NULL COMMENT 'people ahead of this student when they joined',
  source          ENUM('system','manual_observation','simulated') NOT NULL DEFAULT 'system',
  recorded_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_serviceevent_order   FOREIGN KEY (order_id)   REFERENCES orders(id)   ON DELETE SET NULL,
  CONSTRAINT fk_serviceevent_counter FOREIGN KEY (counter_id) REFERENCES counters(id) ON DELETE SET NULL,
  -- The calibration query filters on recorded_at and groups by is_pickup;
  -- this composite index means it never touches the table itself.
  INDEX idx_serviceevent_recent (recorded_at, is_pickup, service_seconds)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 3. Indexes the reporting and calibration queries actually need
-- ---------------------------------------------------------------------------
-- The calibration reader filters orders by HOUR(created_at) over a 60-day
-- window.  Without an index on created_at that is a full scan of every order
-- the cafeteria has ever taken, once per calibration refresh.
DROP PROCEDURE IF EXISTS add_index_if_missing;
DELIMITER //
CREATE PROCEDURE add_index_if_missing(
  IN in_table VARCHAR(64),
  IN in_index VARCHAR(64),
  IN in_columns VARCHAR(255)
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = in_table
      AND INDEX_NAME   = in_index
  ) THEN
    SET @ddl = CONCAT('CREATE INDEX `', in_index, '` ON `', in_table, '` (', in_columns, ')');
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL add_index_if_missing('orders', 'idx_orders_created_at', '`created_at`');
CALL add_index_if_missing('orders', 'idx_orders_status_created', '`status`, `created_at`');
CALL add_index_if_missing('simulation_scenarios', 'idx_simulation_created_at', '`created_at`');

DROP PROCEDURE IF EXISTS add_index_if_missing;

-- ---------------------------------------------------------------------------
-- 4. Reporting views
-- ---------------------------------------------------------------------------
-- FR-17 and NFR-06 require that the college administrator sees summarised
-- figures only, never an individual student's order.  Enforcing that in a
-- view rather than in each controller means the privacy rule holds even if a
-- future endpoint forgets it: there is no student_id in here to leak.

CREATE OR REPLACE VIEW v_peak_hour_performance AS
SELECT
  DATE(o.created_at)                                   AS service_date,
  HOUR(o.created_at)                                   AS service_hour,
  COUNT(*)                                             AS orders_placed,
  SUM(CASE WHEN o.is_preorder = 1 THEN 1 ELSE 0 END)   AS preorders,
  ROUND(
    AVG(CASE WHEN o.ready_at IS NOT NULL
             THEN TIMESTAMPDIFF(SECOND, o.created_at, o.ready_at) / 60.0 END), 2
  )                                                    AS avg_fulfilment_minutes,
  ROUND(
    AVG(CASE WHEN o.completed_at IS NOT NULL AND o.ready_at IS NOT NULL
             THEN TIMESTAMPDIFF(SECOND, o.ready_at, o.completed_at) / 60.0 END), 2
  )                                                    AS avg_collection_lag_minutes
FROM orders o
GROUP BY DATE(o.created_at), HOUR(o.created_at);

-- Daily accuracy of the wait-time predictions — the "prediction accuracy"
-- metric named in Section 6.3 of the proposal, which previously had nothing
-- behind it. Comparing the estimate at the time an order was placed against
-- how long that order actually took is the only honest way to report it.
CREATE OR REPLACE VIEW v_prediction_accuracy AS
SELECT
  DATE(q.recorded_at)                          AS observation_date,
  q.source                                     AS estimate_source,
  COUNT(*)                                     AS observations,
  ROUND(AVG(q.estimated_wait_minutes), 2)      AS avg_predicted_minutes,
  ROUND(AVG(actual.actual_minutes), 2)         AS avg_actual_minutes,
  ROUND(AVG(ABS(q.estimated_wait_minutes - actual.actual_minutes)), 2)
                                               AS mean_absolute_error_minutes
FROM queue_observations q
JOIN (
  SELECT
    o.id,
    o.created_at,
    TIMESTAMPDIFF(SECOND, o.created_at, o.ready_at) / 60.0 AS actual_minutes
  FROM orders o
  WHERE o.ready_at IS NOT NULL
) AS actual
  -- Match each order to the queue snapshot taken closest before it was placed.
  ON actual.created_at BETWEEN q.recorded_at AND (q.recorded_at + INTERVAL 2 MINUTE)
WHERE q.estimated_wait_minutes IS NOT NULL
GROUP BY DATE(q.recorded_at), q.source;

-- ---------------------------------------------------------------------------
-- 5. Backfill
-- ---------------------------------------------------------------------------
-- Existing orders predate the new columns.  Rather than leave them NULL and
-- have the reporting views silently ignore all historical data, derive what
-- can be derived: a completed order's updated_at is its completion time.
UPDATE orders
SET completed_at = updated_at
WHERE status = 'completed' AND completed_at IS NULL;

UPDATE orders
SET ready_at = updated_at
WHERE status = 'ready' AND ready_at IS NULL;

SELECT 'Migration complete. Tables: service_events. Views: v_peak_hour_performance, v_prediction_accuracy.' AS result;
