-- Smart Cafeteria & Resource Queue Optimizer
-- Database schema (MySQL 8+)
-- Maps to entities described in Section 5.1 of the group report:
-- User, MenuItem, Counter, Order, QueueObservation, SimulationScenario
--
-- Also creates the DES calibration table (service_events) and the two
-- reporting views the admin dashboard reads.  If you already have a database
-- built from an earlier version of this file, do NOT re-run it — run
-- migration_2026_10_des.sql instead, which adds the new pieces in place.

CREATE DATABASE IF NOT EXISTS smart_cafeteria
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE smart_cafeteria;

-- ---------------------------------------------------------------
-- Users: student, staff, manager, admin (FR-01, NFR-05)
-- ---------------------------------------------------------------
CREATE TABLE users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  full_name     VARCHAR(100) NOT NULL,
  email         VARCHAR(150) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('student', 'staff', 'manager', 'admin') NOT NULL DEFAULT 'student',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------
-- Menu items shown to students (FR-05, FR-06)
-- ---------------------------------------------------------------
CREATE TABLE menu_items (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  description VARCHAR(255),
  price       DECIMAL(6,2) NOT NULL,
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------
-- Physical serving counters (FR-05, FR-11)
-- ---------------------------------------------------------------
CREATE TABLE counters (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  name              VARCHAR(50) NOT NULL,
  is_open           BOOLEAN NOT NULL DEFAULT FALSE,
  assigned_staff_id INT NULL,
  -- Counters are not interchangeable: the thali counter is slower than the
  -- tea counter, and a dedicated pickup point is faster than both.  Averaging
  -- them into one service-time distribution would hide exactly the difference
  -- a manager would act on, so the DES model calibrates per profile.
  service_profile   ENUM('standard', 'fast', 'preorder_pickup') NOT NULL DEFAULT 'standard',
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_counter_staff FOREIGN KEY (assigned_staff_id)
    REFERENCES users(id) ON DELETE SET NULL
);

-- ---------------------------------------------------------------
-- Orders placed by students (FR-06, FR-07, FR-08, FR-10)
-- ---------------------------------------------------------------
CREATE TABLE orders (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  student_id            INT NOT NULL,
  counter_id            INT NULL,
  status                ENUM('received', 'preparing', 'ready', 'completed', 'cancelled') NOT NULL DEFAULT 'received',
  is_preorder           BOOLEAN NOT NULL DEFAULT TRUE
                        COMMENT 'TRUE = placed through the app, FALSE = walk-in logged at the counter',
  estimated_pickup_time DATETIME NULL,
  total_amount          DECIMAL(8,2) NULL COMMENT 'denormalised order value, for reporting',
  -- One timestamp per state transition rather than relying on updated_at.
  -- updated_at is overwritten at every change, so by the time an order is
  -- completed the moment it entered preparation is gone — and that interval
  -- is precisely what the DES model calibrates its service times against.
  preparing_at          DATETIME NULL,
  ready_at              DATETIME NULL,
  completed_at          DATETIME NULL,
  created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_order_student FOREIGN KEY (student_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_order_counter FOREIGN KEY (counter_id)
    REFERENCES counters(id) ON DELETE SET NULL,
  INDEX idx_orders_student (student_id),
  INDEX idx_orders_status (status),
  -- The DES calibration reader filters orders by HOUR(created_at) over a
  -- rolling 60-day window; without this it scans every order ever taken.
  INDEX idx_orders_created_at (created_at),
  INDEX idx_orders_status_created (status, created_at)
);

-- ---------------------------------------------------------------
-- Line items within an order (many-to-many: orders <-> menu_items)
-- ---------------------------------------------------------------
CREATE TABLE order_items (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  order_id     INT NOT NULL,
  menu_item_id INT NOT NULL,
  quantity     INT NOT NULL DEFAULT 1,
  unit_price   DECIMAL(6,2) NOT NULL,
  CONSTRAINT fk_orderitem_order FOREIGN KEY (order_id)
    REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_orderitem_menuitem FOREIGN KEY (menu_item_id)
    REFERENCES menu_items(id) ON DELETE RESTRICT
);

-- ---------------------------------------------------------------
-- Periodic snapshots of queue length / wait time (FR-02, FR-03, NFR-09)
-- Used for both the live banner and historical reporting (FR-14)
-- ---------------------------------------------------------------
CREATE TABLE queue_observations (
  id                     INT AUTO_INCREMENT PRIMARY KEY,
  recorded_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  queue_length           INT NOT NULL,
  -- An estimate of "12 waiting" is meaningless without knowing whether 1 or 4
  -- counters were serving them.  Recording it is what makes these snapshots
  -- usable afterwards for validating the model against reality.
  open_counters          INT NOT NULL DEFAULT 0,
  estimated_wait_minutes DECIMAL(5,2) NULL,
  source                 ENUM('live_count', 'des_model') NOT NULL DEFAULT 'live_count',
  model_version          VARCHAR(20) NULL COMMENT 'which DES model version produced the estimate',
  INDEX idx_queueobs_recorded_at (recorded_at)
);

-- ---------------------------------------------------------------
-- What-if staffing/counter scenarios run by manager/admin (FR-12, FR-13)
-- ---------------------------------------------------------------
CREATE TABLE simulation_scenarios (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  created_by   INT NOT NULL,
  scenario_name VARCHAR(100) NOT NULL,
  parameters   JSON NOT NULL COMMENT 'e.g. {"counters_open":3,"staff_count":5,"arrival_rate":40}',
  results      JSON NULL COMMENT 'DES engine output: {"avg_wait":6.2,"max_queue":18}',
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_simulation_user FOREIGN KEY (created_by)
    REFERENCES users(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------
-- Observed service times — the DES calibration sample
-- ---------------------------------------------------------------
-- One row per completed service.  des-engine/des/calibration.py fits the
-- lognormal service-time distribution against this table, which is what lets
-- the model improve as the cafeteria runs instead of staying frozen at the
-- Sprint 1 stopwatch readings (the weakness admitted in Section 7.1).
--
-- Kept separate from `orders` deliberately: the manually timed observations
-- from Sprint 1 have no order row at all, and they still belong in the sample.
CREATE TABLE service_events (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  order_id         INT NULL COMMENT 'NULL for manually timed observations',
  counter_id       INT NULL,
  is_pickup        BOOLEAN NOT NULL DEFAULT FALSE
                   COMMENT 'TRUE = collecting a pre-order (fast), FALSE = ordering at the counter',
  service_seconds  DECIMAL(8,2) NOT NULL,
  queue_on_arrival INT NULL COMMENT 'people ahead of this student when they joined',
  source           ENUM('system', 'manual_observation', 'simulated') NOT NULL DEFAULT 'system',
  recorded_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_serviceevent_order   FOREIGN KEY (order_id)   REFERENCES orders(id)   ON DELETE SET NULL,
  CONSTRAINT fk_serviceevent_counter FOREIGN KEY (counter_id) REFERENCES counters(id) ON DELETE SET NULL,
  INDEX idx_serviceevent_recent (recorded_at, is_pickup, service_seconds)
);

-- ---------------------------------------------------------------
-- Reporting views (FR-13, FR-14, FR-17)
-- ---------------------------------------------------------------
-- FR-17 and NFR-06 require administrators to see summarised figures only.
-- Enforcing that in a view rather than in each controller means the privacy
-- rule still holds if a future endpoint forgets it: there is no student_id
-- in here to leak.
CREATE OR REPLACE VIEW v_peak_hour_performance AS
SELECT
  DATE(o.created_at)                                 AS service_date,
  HOUR(o.created_at)                                 AS service_hour,
  COUNT(*)                                           AS orders_placed,
  SUM(CASE WHEN o.is_preorder = 1 THEN 1 ELSE 0 END) AS preorders,
  ROUND(AVG(CASE WHEN o.ready_at IS NOT NULL
                 THEN TIMESTAMPDIFF(SECOND, o.created_at, o.ready_at) / 60.0 END), 2)
                                                     AS avg_fulfilment_minutes,
  ROUND(AVG(CASE WHEN o.completed_at IS NOT NULL AND o.ready_at IS NOT NULL
                 THEN TIMESTAMPDIFF(SECOND, o.ready_at, o.completed_at) / 60.0 END), 2)
                                                     AS avg_collection_lag_minutes
FROM orders o
GROUP BY DATE(o.created_at), HOUR(o.created_at);

-- "Prediction accuracy" is named as an evaluation metric in Section 6.3 of
-- the proposal but had nothing behind it.  This compares the wait estimate
-- shown at the moment an order was placed against how long that order
-- actually took, which is the only honest way to report it.
CREATE OR REPLACE VIEW v_prediction_accuracy AS
SELECT
  DATE(q.recorded_at)                     AS observation_date,
  q.source                                AS estimate_source,
  COUNT(*)                                AS observations,
  ROUND(AVG(q.estimated_wait_minutes), 2) AS avg_predicted_minutes,
  ROUND(AVG(actual.actual_minutes), 2)    AS avg_actual_minutes,
  ROUND(AVG(ABS(q.estimated_wait_minutes - actual.actual_minutes)), 2)
                                          AS mean_absolute_error_minutes
FROM queue_observations q
JOIN (
  SELECT o.id, o.created_at,
         TIMESTAMPDIFF(SECOND, o.created_at, o.ready_at) / 60.0 AS actual_minutes
  FROM orders o
  WHERE o.ready_at IS NOT NULL
) AS actual
  ON actual.created_at BETWEEN q.recorded_at AND (q.recorded_at + INTERVAL 2 MINUTE)
WHERE q.estimated_wait_minutes IS NOT NULL
GROUP BY DATE(q.recorded_at), q.source;
