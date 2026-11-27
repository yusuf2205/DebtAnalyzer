-- Документы к платежам
CREATE TABLE "PaymentDocument" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    CONSTRAINT "PaymentDocument_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PaymentDocument_paymentId_idx" ON "PaymentDocument"("paymentId");
ALTER TABLE "PaymentDocument" ADD CONSTRAINT "PaymentDocument_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
