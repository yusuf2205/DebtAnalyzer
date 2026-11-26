-- AlterTable
ALTER TABLE "PlanEntry" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlanEntry_contractId_year_month_week_key" ON "PlanEntry"("contractId", "year", "month", "week");


-- Плановые суммы не отрицательны (инвариант уже есть с миграции hardening); неделя 1–4, месяц 1–12.
