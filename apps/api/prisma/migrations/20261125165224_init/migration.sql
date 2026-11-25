-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'FINANCE', 'MANAGER', 'VIEWER');

-- CreateEnum
CREATE TYPE "CurrencyCode" AS ENUM ('USD', 'UZS', 'RUB', 'EUR');

-- CreateEnum
CREATE TYPE "EntityStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('UPLOADED', 'ANALYZED', 'COMMITTING', 'COMMITTED', 'FAILED');

-- CreateEnum
CREATE TYPE "RateStatus" AS ENUM ('PENDING_CONFIRMATION', 'CONFIRMED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReconStatus" AS ENUM ('PENDING', 'MATCHED', 'CONFIRMED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PlanSource" AS ENUM ('IMPORT', 'MANUAL');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "csrfToken" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "userEmail" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "meta" JSONB,
    "ip" TEXT,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "taxId" TEXT,
    "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "mergedIntoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierAlias" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "exactKey" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'IMPORT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contract" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "project" TEXT,
    "number" TEXT,
    "contractDate" DATE,
    "goods" TEXT,
    "amount" DECIMAL(24,2) NOT NULL,
    "currency" "CurrencyCode" NOT NULL,
    "openingPaid" DECIMAL(24,2) NOT NULL,
    "sourcePaid" DECIMAL(24,2),
    "executor" TEXT,
    "notes" TEXT,
    "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "identityKey" TEXT NOT NULL,
    "sourceBatchId" TEXT,
    "sourceRow" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanEntry" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "week" INTEGER NOT NULL,
    "amount" DECIMAL(24,2) NOT NULL,
    "currency" "CurrencyCode" NOT NULL,
    "source" "PlanSource" NOT NULL DEFAULT 'IMPORT',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FxRate" (
    "id" TEXT NOT NULL,
    "currency" "CurrencyCode" NOT NULL,
    "uzsPerUnit" DECIMAL(24,8) NOT NULL,
    "effectiveDate" DATE,
    "source" TEXT NOT NULL,
    "status" "RateStatus" NOT NULL DEFAULT 'PENDING_CONFIRMATION',
    "setById" TEXT,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FxRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "sheetName" TEXT,
    "mapping" JSONB,
    "overrides" JSONB,
    "planYear" INTEGER,
    "summary" JSONB,
    "extras" JSONB,
    "sheets" JSONB,
    "report" JSONB,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMP(3),

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRow" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "ImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationTask" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" "ReconStatus" NOT NULL DEFAULT 'PENDING',
    "contractId" TEXT,
    "batchId" TEXT,
    "details" JSONB NOT NULL,
    "resolution" JSONB,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");

-- CreateIndex
CREATE INDEX "Supplier_name_idx" ON "Supplier"("name");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierAlias_exactKey_key" ON "SupplierAlias"("exactKey");

-- CreateIndex
CREATE INDEX "SupplierAlias_supplierId_idx" ON "SupplierAlias"("supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "Contract_identityKey_key" ON "Contract"("identityKey");

-- CreateIndex
CREATE INDEX "Contract_supplierId_idx" ON "Contract"("supplierId");

-- CreateIndex
CREATE INDEX "Contract_currency_idx" ON "Contract"("currency");

-- CreateIndex
CREATE INDEX "Contract_project_idx" ON "Contract"("project");

-- CreateIndex
CREATE INDEX "PlanEntry_contractId_idx" ON "PlanEntry"("contractId");

-- CreateIndex
CREATE INDEX "PlanEntry_year_month_week_idx" ON "PlanEntry"("year", "month", "week");

-- CreateIndex
CREATE INDEX "FxRate_currency_effectiveDate_idx" ON "FxRate"("currency", "effectiveDate");

-- CreateIndex
CREATE INDEX "ImportBatch_fileSha256_idx" ON "ImportBatch"("fileSha256");

-- CreateIndex
CREATE INDEX "ImportBatch_createdAt_idx" ON "ImportBatch"("createdAt");

-- CreateIndex
CREATE INDEX "ImportRow_batchId_status_idx" ON "ImportRow"("batchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ImportRow_batchId_rowNumber_key" ON "ImportRow"("batchId", "rowNumber");

-- CreateIndex
CREATE INDEX "ReconciliationTask_status_idx" ON "ReconciliationTask"("status");

-- CreateIndex
CREATE INDEX "ReconciliationTask_contractId_idx" ON "ReconciliationTask"("contractId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierAlias" ADD CONSTRAINT "SupplierAlias_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanEntry" ADD CONSTRAINT "PlanEntry_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
