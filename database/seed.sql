USE smart_cafeteria;

-- Sample counters
INSERT INTO counters (name, is_open) VALUES
  ('Counter 1', TRUE),
  ('Counter 2', TRUE),
  ('Counter 3', FALSE);

-- Sample menu items
INSERT INTO menu_items (name, description, price, is_available) VALUES
  ('Chicken Momo (10 pcs)', 'Steamed dumplings with achar', 150.00, TRUE),
  ('Veg Thali', 'Rice, dal, two curries, pickle', 180.00, TRUE),
  ('Chow Mein', 'Stir-fried noodles with vegetables', 120.00, TRUE),
  ('Milk Tea', 'Hot Nepali-style milk tea', 40.00, TRUE);

-- NOTE: password_hash values below are bcrypt hashes of "Password123!"
-- generated only for local demo/testing — replace before any real deployment.
INSERT INTO users (full_name, email, password_hash, role) VALUES
  ('Demo Student', 'student@example.com', '$2b$10$qO2LG45doJVZWHJof8vEH.KHlbf0RJIlwwatw/yI1rFvLbjO6D1IS', 'student'),
  ('Demo Staff', 'staff@example.com',   '$2b$10$qO2LG45doJVZWHJof8vEH.KHlbf0RJIlwwatw/yI1rFvLbjO6D1IS', 'staff'),
  ('Demo Manager', 'manager@example.com', '$2b$10$qO2LG45doJVZWHJof8vEH.KHlbf0RJIlwwatw/yI1rFvLbjO6D1IS', 'manager'),
  ('Demo Admin', 'admin@example.com', '$2b$10$qO2LG45doJVZWHJof8vEH.KHlbf0RJIlwwatw/yI1rFvLbjO6D1IS', 'admin');
