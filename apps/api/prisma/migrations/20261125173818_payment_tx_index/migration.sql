-- Исправленный платёж (correctsPaymentId) может иметь тот же банковский номер, что и сторнированный оригинал.
DROP INDEX IF EXISTS payment_tx_unique;
CREATE UNIQUE INDEX payment_tx_unique ON "Payment"("contractId", "transactionNo")
  WHERE "transactionNo" IS NOT NULL AND status NOT IN ('REJECTED', 'CANCELLED') AND "correctsPaymentId" IS NULL;
