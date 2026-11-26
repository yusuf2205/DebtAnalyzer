-- CreateTable
CREATE TABLE "DebtSnapshot" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "currency" "CurrencyCode" NOT NULL,
    "contracts" INTEGER NOT NULL,
    "amount" DECIMAL(24,2) NOT NULL,
    "paid" DECIMAL(24,2) NOT NULL,
    "debt" DECIMAL(24,2) NOT NULL,
    "overpaid" DECIMAL(24,2) NOT NULL,
    "planned" DECIMAL(24,2) NOT NULL,
    "debtUsd" DECIMAL(24,2),
    "rateUsed" DECIMAL(24,8),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DebtSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DebtSnapshot_date_idx" ON "DebtSnapshot"("date");

-- CreateIndex
CREATE UNIQUE INDEX "DebtSnapshot_date_currency_key" ON "DebtSnapshot"("date", "currency");

