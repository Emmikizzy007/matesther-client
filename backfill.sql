-- MATESTHER v2: MONOGRAMMING stage + inspection system (applied to live data)

-- 1. New monogramming worker
INSERT INTO workers (organization_id, name, phone, specialty, payment_type, payment_rate, status)
SELECT 1, 'Mrs. Helen Ogun', '+234 808 999 1122', 'Monogrammer', 'PER_PIECE', 120, 'ACTIVE'
WHERE NOT EXISTS (SELECT 1 FROM workers WHERE name = 'Mrs. Helen Ogun');

-- 2. Backfill inspection counters on existing operations
-- Batch 1 (B-001-A, 250 shirts): cutting fully approved; sewing partially inspected
UPDATE production_operations SET quantity_inspected = 250, quantity_approved = 250, inspector = 'Esther Adejugba', submitted_at = '2026-06-24 16:00', inspected_at = '2026-06-24 17:00' WHERE id = 1;
UPDATE production_operations SET quantity_inspected = 160, quantity_approved = 155, quantity_rework = 5, inspector = 'Esther Adejugba', submitted_at = '2026-08-25 16:00', inspected_at = '2026-09-05 14:00', status = 'SUBMITTED' WHERE id = 2;
-- Batch 2 (B-001-B, 250 trousers)
UPDATE production_operations SET quantity_inspected = 250, quantity_approved = 250, inspector = 'Esther Adejugba', submitted_at = '2026-06-25 15:30', inspected_at = '2026-06-25 16:00' WHERE id = 8;
UPDATE production_operations SET quantity_inspected = 100, quantity_approved = 95, quantity_rework = 5, inspector = 'Esther Adejugba', submitted_at = '2026-08-27 16:00', inspected_at = '2026-08-29 11:30', status = 'SUBMITTED' WHERE id = 9;
-- Batch 5 (B-003-A, 120 - completed order): every stage inspected & approved
UPDATE production_operations SET quantity_inspected = 120, quantity_approved = 120, inspector = 'Esther Adejugba', submitted_at = completed_at - interval '2 days', inspected_at = completed_at WHERE id BETWEEN 29 AND 35;

-- 3. Recalculate remaining under the new rule (remaining = received - approved - rejected)
UPDATE production_operations SET quantity_remaining = GREATEST(0, quantity_received - quantity_approved - quantity_rejected);

-- 4. Insert MONOGRAMMING operations into every existing batch (between Sewing and Buttonhole)
INSERT INTO production_operations (production_batch_id, stage, worker_id, quantity_received, quantity_completed, quantity_rejected, quantity_remaining, quantity_inspected, quantity_approved, quantity_rework, inspector, status, assigned_at, expected_completion_date, completed_at, submitted_at, inspected_at, notes) VALUES
(1, 'MONOGRAMMING', (SELECT id FROM workers WHERE name = 'Mrs. Helen Ogun'), 155, 0, 0, 155, 0, 0, 0, NULL, 'PENDING', '2026-08-20 09:00', '2026-09-12', NULL, NULL, NULL, 'School monogram on chest pocket - approved shirts from sewing (155)'),
(2, 'MONOGRAMMING', (SELECT id FROM workers WHERE name = 'Mrs. Helen Ogun'), 95, 0, 0, 95, 0, 0, 0, NULL, 'PENDING', '2026-08-05 09:00', '2026-09-11', NULL, NULL, NULL, 'Monogram on trousers/shorts - approved from sewing (95)'),
(3, 'MONOGRAMMING', (SELECT id FROM workers WHERE name = 'Mrs. Helen Ogun'), 0, 0, 0, 0, 0, 0, 0, NULL, 'PENDING', '2026-07-12 08:30', '2026-09-12', NULL, NULL, NULL, 'Awaiting sewn shirts'),
(4, 'MONOGRAMMING', (SELECT id FROM workers WHERE name = 'Mrs. Helen Ogun'), 0, 0, 0, 0, 0, 0, 0, NULL, 'PENDING', '2026-07-14 08:30', '2026-09-13', NULL, NULL, NULL, 'Awaiting sewn garments'),
(5, 'MONOGRAMMING', (SELECT id FROM workers WHERE name = 'Mrs. Helen Ogun'), 120, 120, 0, 0, 120, 120, 0, 'Esther Adejugba', 'COMPLETED', '2026-06-19 09:00', '2026-06-24', '2026-06-22 15:00', '2026-06-22 10:00', '2026-06-22 15:00', 'Crest embroidered on left chest - all 120 blazers approved'),
(6, 'MONOGRAMMING', (SELECT id FROM workers WHERE name = 'Mrs. Helen Ogun'), 0, 0, 0, 0, 0, 0, 0, NULL, 'PENDING', '2026-08-05 08:30', '2026-09-10', NULL, NULL, NULL, 'Awaiting sewn garments');

-- 5. Inspection audit trail for all backfilled stages
INSERT INTO stage_inspections (production_operation_id, inspected_by, quantity_approved, quantity_rework, quantity_rejected, notes, inspected_at) VALUES
(1, 'Esther Adejugba', 250, 0, 0, 'All 250 shirt panels cut to spec.', '2026-06-24 17:00'),
(2, 'Esther Adejugba', 145, 5, 0, '150 inspected: 145 approved, 5 sent back for loose side seams.', '2026-08-28 15:30'),
(2, 'Esther Adejugba', 10, 0, 0, 'Rework batch + 5 more submitted - all approved.', '2026-09-05 14:00'),
(8, 'Esther Adejugba', 250, 0, 0, 'Trouser panels + elastic lengths approved.', '2026-06-25 16:00'),
(9, 'Esther Adejugba', 95, 5, 0, '100 inspected: 95 approved, 5 sent back for faulty zips.', '2026-08-29 11:30'),
(29, 'Esther Adejugba', 120, 0, 0, 'Blazer + shirt panels approved.', '2026-05-11 16:00'),
(30, 'Esther Adejugba', 120, 0, 0, '2 armhole reworks fixed and approved.', '2026-06-18 17:00'),
(31, 'Esther Adejugba', 120, 0, 0, 'Buttonholes checked - approved.', '2026-06-30 14:00'),
(32, 'Esther Adejugba', 120, 0, 0, 'Buttons secure - approved.', '2026-07-04 13:00'),
(33, 'Esther Adejugba', 120, 0, 0, 'Ironing approved.', '2026-07-08 16:00'),
(34, 'Esther Adejugba', 120, 0, 0, '12 bundles checked and approved.', '2026-07-25 12:00'),
(35, 'Esther Adejugba', 120, 0, 0, 'Delivered - school store signed the waybill.', '2026-07-29 11:00');
