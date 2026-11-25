-- CreateEnum
CREATE TYPE "GoogleMode" AS ENUM ('PUBLIC', 'OAUTH');

-- AlterTable
ALTER TABLE "ImportBatch" ADD COLUMN     "sourceId" TEXT;

-- CreateTable
CREATE TABLE "GoogleCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT,
    "refreshTokenEnc" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoogleCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleSource" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "spreadsheetId" TEXT NOT NULL,
    "mode" "GoogleMode" NOT NULL,
    "credentialId" TEXT,
    "sheetName" TEXT NOT NULL,
    "planYear" INTEGER NOT NULL,
    "autoSync" BOOLEAN NOT NULL DEFAULT false,
    "intervalMinutes" INTEGER NOT NULL DEFAULT 60,
    "lastSyncAt" TIMESTAMP(3),
    "nextSyncAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastError" TEXT,
    "lastBatchId" TEXT,
    "lastChanges" JSONB,
    "lastSha" TEXT,
    "syncStartedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoogleSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GoogleCredential_userId_key" ON "GoogleCredential"("userId");

-- CreateIndex
CREATE INDEX "GoogleSource_autoSync_nextSyncAt_idx" ON "GoogleSource"("autoSync", "nextSyncAt");

-- CreateIndex
CREATE INDEX "ImportBatch_sourceId_idx" ON "ImportBatch"("sourceId");

-- AddForeignKey
ALTER TABLE "GoogleSource" ADD CONSTRAINT "GoogleSource_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "GoogleCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;
