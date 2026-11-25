-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentKind" AS ENUM ('PAYMENT', 'REFUND', 'REVERSAL');

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "paymentDate" DATE NOT NULL,
    "amount" DECIMAL(24,2) NOT NULL,
    "currency" "CurrencyCode" NOT NULL,
    "kind" "PaymentKind" NOT NULL DEFAULT 'PAYMENT',
    "status" "PaymentStatus" NOT NULL DEFAULT 'DRAFT',
    "bankDocument" TEXT,
    "transactionNo" TEXT,
    "comment" TEXT,
    "createdById" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedById" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "signedAmount" DECIMAL(24,2),
    "reflectedInOpening" BOOLEAN NOT NULL DEFAULT false,
    "reflectedTaskId" TEXT,
    "reversesPaymentId" TEXT,
    "reversalReason" TEXT,
    "correctsPaymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_reversesPaymentId_key" ON "Payment"("reversesPaymentId");

-- CreateIndex
CREATE INDEX "Payment_contractId_idx" ON "Payment"("contractId");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE INDEX "Payment_paymentDate_idx" ON "Payment"("paymentDate");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Инварианты платежей.
ALTER TABLE "Payment" ADD CONSTRAINT payment_amount_positive CHECK (amount > 0);
ALTER TABLE "Payment" ADD CONSTRAINT payment_approved_has_effect CHECK (status <> 'APPROVED' OR "signedAmount" IS NOT NULL);
-- Один и тот же банковский номер транзакции не может быть зарегистрирован дважды по договору (отклонённые/отменённые не считаются).
CREATE UNIQUE INDEX payment_tx_unique ON "Payment"("contractId", "transactionNo") WHERE "transactionNo" IS NOT NULL AND status NOT IN ('REJECTED', 'CANCELLED');

-- Подтверждённый платёж нельзя удалить или изменить (суммы, даты, договор, статус): только сторно новой записью.
-- Разрешено менять только отметку «учтён в начальном остатке» (результат сверки).
CREATE OR REPLACE FUNCTION pf_payment_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'APPROVED' THEN
      RAISE EXCEPTION 'Approved payments cannot be deleted; create a reversal';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'APPROVED' AND (
       NEW.status <> 'APPROVED' OR NEW.amount <> OLD.amount OR NEW."contractId" <> OLD."contractId" OR NEW.currency <> OLD.currency
    OR NEW."paymentDate" <> OLD."paymentDate" OR NEW.kind <> OLD.kind OR NEW."signedAmount" IS DISTINCT FROM OLD."signedAmount"
    OR NEW."reversesPaymentId" IS DISTINCT FROM OLD."reversesPaymentId") THEN
    RAISE EXCEPTION 'Approved payments are immutable; create a reversal';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_guard BEFORE UPDATE OR DELETE ON "Payment" FOR EACH ROW EXECUTE FUNCTION pf_payment_guard();
