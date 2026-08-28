ALTER TABLE service_orders ADD COLUMN published_task_id INTEGER REFERENCES tasks(id);
ALTER TABLE service_orders ADD COLUMN claimed_at INTEGER;
ALTER TABLE service_orders ADD COLUMN delivery_submission_id INTEGER REFERENCES submissions(id);
ALTER TABLE service_orders ADD COLUMN delivery_artifact TEXT;
ALTER TABLE service_orders ADD COLUMN delivered_at INTEGER;
ALTER TABLE service_orders ADD COLUMN accepted_at INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS service_orders_published_task
  ON service_orders(published_task_id)
  WHERE published_task_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS service_orders_delivery_submission
  ON service_orders(delivery_submission_id)
  WHERE delivery_submission_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_acceptance_receipts (
  id TEXT PRIMARY KEY,
  task_id INTEGER NOT NULL UNIQUE,
  submission_id INTEGER NOT NULL UNIQUE,
  verifier TEXT NOT NULL,
  verification_summary TEXT NOT NULL,
  evidence_url TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id),
  FOREIGN KEY(submission_id) REFERENCES submissions(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS service_order_lifecycle_events
  ON order_events(order_id,kind)
  WHERE kind IN ('payment_verified_and_task_published','task_claimed','delivery_submitted','delivery_accepted');

CREATE TRIGGER IF NOT EXISTS service_order_requires_linked_delivery
BEFORE UPDATE OF status ON tasks
WHEN NEW.status = 'completed'
  AND OLD.status IS NOT 'completed'
  AND EXISTS (SELECT 1 FROM service_orders WHERE published_task_id = NEW.id)
  AND NOT EXISTS (
    SELECT 1
    FROM service_orders
    JOIN submissions ON submissions.id = service_orders.delivery_submission_id
    WHERE service_orders.published_task_id = NEW.id
      AND submissions.task_id = NEW.id
      AND submissions.status = 'accepted'
  )
BEGIN
  SELECT RAISE(ABORT, 'linked service-order delivery must be accepted before task completion');
END;

CREATE TRIGGER IF NOT EXISTS service_order_task_completed
AFTER UPDATE OF status ON tasks
WHEN NEW.status = 'completed' AND OLD.status IS NOT 'completed'
BEGIN
  UPDATE service_orders
  SET status = 'completed',
      accepted_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
      updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
  WHERE published_task_id = NEW.id
    AND payment_status = 'verified'
    AND accepted_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM submissions
      WHERE submissions.id = service_orders.delivery_submission_id
        AND submissions.task_id = NEW.id
        AND submissions.status = 'accepted'
    );

  INSERT INTO order_events(order_id,kind,details,created_at)
  SELECT service_orders.id,
         'delivery_accepted',
         json_object(
           'task_id', NEW.id,
           'submission_id', service_orders.delivery_submission_id,
           'artifact', service_orders.delivery_artifact,
           'payout_authority', 'owner_signature_required'
         ),
         service_orders.accepted_at
  FROM service_orders
  WHERE service_orders.published_task_id = NEW.id
    AND service_orders.status = 'completed'
    AND service_orders.accepted_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM order_events
      WHERE order_events.order_id = service_orders.id
        AND order_events.kind = 'delivery_accepted'
    );
END;
