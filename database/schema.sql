-- Smart Cafeteria & Resource Queue Optimizer
-- Database schema (MySQL 8+)
-- Maps to entities described in Section 5.1 of the group report:
-- User, MenuItem, Counter, Order, QueueObservation, SimulationScenario

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
  status                ENUM('received', 'preparing', 'ready', 'completed') NOT NULL DEFAULT 'received',
  estimated_pickup_time DATETIME NULL,
  created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_order_student FOREIGN KEY (student_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_order_counter FOREIGN KEY (counter_id)
    REFERENCES counters(id) ON DELETE SET NULL,
  INDEX idx_orders_student (student_id),
  INDEX idx_orders_status (status)
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
  estimated_wait_minutes DECIMAL(5,2) NULL,
  source                 ENUM('live_count', 'des_model') NOT NULL DEFAULT 'live_count',
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
