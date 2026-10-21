-- Database guards for the booking state machine (SPEC §8.4) and the invoice lifecycle (SPEC §9.6).
-- The application writes with compare-and-set; these triggers reject anything else, even raw SQL.

CREATE OR REPLACE FUNCTION holdline_booking_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status::text, NEW.status::text) IN (
      ('pending_payment', 'authorized'),
      ('pending_payment', 'expired'),
      ('authorized', 'completed'),
      ('authorized', 'no_show'),
      ('authorized', 'cancelled'),
      ('completed', 'captured'),
      ('no_show', 'captured'),
      ('no_show', 'voided'),
      ('cancelled', 'voided'),
      ('cancelled', 'captured'),
      ('captured', 'paid_out')
    )
  ) THEN
    RAISE EXCEPTION 'illegal booking status change % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  -- The price snapshot is fixed at creation (SPEC §9.1).
  IF NEW.price_cents IS DISTINCT FROM OLD.price_cents
    OR NEW.no_show_fee_cents IS DISTINCT FROM OLD.no_show_fee_cents
    OR NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION 'the price snapshot of booking % is immutable', OLD.ref
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER bookings_guard
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION holdline_booking_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION holdline_invoice_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status::text, NEW.status::text) IN (
      ('draft', 'sent'),
      ('draft', 'cancelled'),
      ('sent', 'paid'),
      ('sent', 'cancelled')
    )
  ) THEN
    RAISE EXCEPTION 'illegal invoice status change % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.total_cents IS DISTINCT FROM OLD.total_cents OR NEW.items IS DISTINCT FROM OLD.items THEN
    RAISE EXCEPTION 'the items of invoice % are immutable', OLD.invoice_number
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER invoices_guard
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION holdline_invoice_guard();
--> statement-breakpoint
-- booking_events is append-only (rows still go with their booking on delete).
CREATE OR REPLACE FUNCTION holdline_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER booking_events_append_only
  BEFORE UPDATE ON booking_events
  FOR EACH ROW EXECUTE FUNCTION holdline_append_only();
