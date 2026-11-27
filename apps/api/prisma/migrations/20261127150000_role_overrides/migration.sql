-- Настраиваемые права встроенных ролей (кроме SUPER_ADMIN)
CREATE TABLE "RoleOverride" (
    "role" TEXT NOT NULL,
    "permissions" TEXT[],
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RoleOverride_pkey" PRIMARY KEY ("role")
);
ALTER TABLE "RoleOverride" ADD CONSTRAINT "RoleOverride_not_super" CHECK ("role" <> 'SUPER_ADMIN');
ALTER TABLE "RoleOverride" ADD CONSTRAINT "RoleOverride_no_roles_manage" CHECK (NOT ('roles.manage' = ANY ("permissions")));
