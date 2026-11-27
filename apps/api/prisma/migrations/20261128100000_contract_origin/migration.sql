-- Происхождение договора (местный / зарубежный): подтверждается пользователем
CREATE TYPE "ContractOrigin" AS ENUM ('LOCAL', 'FOREIGN');
ALTER TABLE "Contract" ADD COLUMN "origin" "ContractOrigin";
CREATE INDEX "Contract_origin_idx" ON "Contract"("origin");
