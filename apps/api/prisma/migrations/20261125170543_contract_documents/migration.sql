-- CreateTable
CREATE TABLE "ContractDocument" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,

    CONSTRAINT "ContractDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContractDocument_contractId_idx" ON "ContractDocument"("contractId");

-- AddForeignKey
ALTER TABLE "ContractDocument" ADD CONSTRAINT "ContractDocument_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
