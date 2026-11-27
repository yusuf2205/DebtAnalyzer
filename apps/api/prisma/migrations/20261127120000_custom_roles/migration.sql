-- AlterTable
ALTER TABLE "User" ADD COLUMN     "customRoleId" TEXT;

-- CreateTable
CREATE TABLE "CustomRole" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" TEXT[],
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomRole_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomRole_name_key" ON "CustomRole"("name");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_customRoleId_fkey" FOREIGN KEY ("customRoleId") REFERENCES "CustomRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Имя роли уникально без учёта регистра
CREATE UNIQUE INDEX "CustomRole_name_lower_key" ON "CustomRole"(lower("name"));

-- Защита от повышения привилегий на уровне БД: управление ролями принадлежит только SUPER_ADMIN и не может быть выдано настраиваемой роли
ALTER TABLE "CustomRole" ADD CONSTRAINT "CustomRole_no_roles_manage" CHECK (NOT ('roles.manage' = ANY ("permissions")));
