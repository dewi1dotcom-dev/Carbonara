-- Invoices (0.50.0): a work order's labour and parts end in an invoice (faktura) issued by Carbonara.
--
-- An issued invoice is accounting documentation (bokføringsloven / bokføringsforskriften): numbered in one unbroken
-- series, never changed and never deleted (a trigger blocks it), kept at least 5 years. Mistakes are corrected with a
-- credit note (kreditnota) = an invoice of kind 'credit_note' with negative amounts that points to the invoice.
-- Seller, buyer, car and lines are stored as they were on the day (snapshots), so a later change or the deletion of a
-- customer never changes an invoice. Only the payment (paid_at / paid_by) can be recorded afterwards.

CREATE TABLE invoices (
    id                bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    number            integer       NOT NULL UNIQUE CHECK (number > 0),
    kind              text          NOT NULL DEFAULT 'invoice' CHECK (kind IN ('invoice', 'credit_note')),
    credits_invoice_id bigint       UNIQUE REFERENCES invoices (id),   -- credit note: the invoice it cancels
    work_order_id     bigint        REFERENCES work_orders (id) ON DELETE SET NULL,
    customer_id       bigint        REFERENCES customers (id) ON DELETE SET NULL,
    issue_date        date          NOT NULL,
    delivery_date     date          NOT NULL,
    due_date          date          NOT NULL,
    seller            jsonb         NOT NULL,   -- name, org_no, vat_registered, foretaksregisteret, address, phone, email, bank_account
    buyer             jsonb         NOT NULL,   -- name, customer_no, org_no, address, postal_code, city
    car               jsonb,                    -- registration_number, make, model, vin, km
    lines             jsonb         NOT NULL,   -- [{kind, part_number, text, quantity, unit, unit_price, vat_rate, total_ex}]
    vat_lines         jsonb         NOT NULL,   -- [{rate, base, vat}]
    total_ex          numeric(12,2) NOT NULL,
    vat               numeric(12,2) NOT NULL,
    total_inc         numeric(12,2) NOT NULL,
    kid               text,
    note              text,
    parts_order_ids   bigint[]      NOT NULL DEFAULT '{}',   -- parts orders handed out by this invoice
    created_at        timestamptz   NOT NULL DEFAULT now(),
    created_by        bigint        REFERENCES staff (id),
    paid_at           date,
    paid_by           bigint        REFERENCES staff (id),
    paid_marked_at    timestamptz
);
CREATE INDEX invoices_work_order_idx ON invoices (work_order_id);
CREATE INDEX invoices_customer_idx ON invoices (customer_id);
CREATE INDEX invoices_issue_idx ON invoices (issue_date DESC);

-- Issued invoices are never changed or deleted. Allowed afterwards: the payment, and links set to NULL when a work
-- order / customer / staff member is deleted (the invoice keeps its own copy of the details).
CREATE FUNCTION invoices_locked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'An issued invoice can never be deleted';
    END IF;
    IF (NEW.number, NEW.kind, NEW.credits_invoice_id, NEW.issue_date, NEW.delivery_date, NEW.due_date, NEW.seller,
        NEW.buyer, NEW.car, NEW.lines, NEW.vat_lines, NEW.total_ex, NEW.vat, NEW.total_inc, NEW.kid, NEW.note,
        NEW.parts_order_ids, NEW.created_at)
       IS DISTINCT FROM
       (OLD.number, OLD.kind, OLD.credits_invoice_id, OLD.issue_date, OLD.delivery_date, OLD.due_date, OLD.seller,
        OLD.buyer, OLD.car, OLD.lines, OLD.vat_lines, OLD.total_ex, OLD.vat, OLD.total_inc, OLD.kid, OLD.note,
        OLD.parts_order_ids, OLD.created_at) THEN
        RAISE EXCEPTION 'An issued invoice can never be changed (make a credit note)';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER invoices_locked BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_locked();

-- Work orders: what to bill. Labour = billed_minutes (NULL = the clocked time rounded up to a quarter hour) at
-- labour_rate (NULL = System page rate); extra_lines = other charges; km = mileage printed on the invoice.
ALTER TABLE work_orders
    ADD COLUMN labour_rate    numeric(10,2) CHECK (labour_rate >= 0),
    ADD COLUMN billed_minutes integer       CHECK (billed_minutes >= 0),
    ADD COLUMN extra_lines    jsonb         NOT NULL DEFAULT '[]',
    ADD COLUMN km             integer       CHECK (km >= 0),
    ADD COLUMN invoice_id     bigint        REFERENCES invoices (id);
ALTER TABLE work_orders DROP CONSTRAINT work_orders_status_check;
ALTER TABLE work_orders ADD CONSTRAINT work_orders_status_check
    CHECK (status IN ('open', 'in_progress', 'done', 'invoiced', 'cancelled'));
