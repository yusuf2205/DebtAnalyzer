-- Журнал аудита — только добавление. Любая попытка UPDATE/DELETE/TRUNCATE отклоняется на уровне БД.
CREATE OR REPLACE FUNCTION pf_audit_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION pf_audit_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION pf_audit_immutable();

-- Инварианты данных.
ALTER TABLE "PlanEntry" ADD CONSTRAINT plan_week_range CHECK (week BETWEEN 1 AND 4 AND month BETWEEN 1 AND 12 AND amount >= 0);
ALTER TABLE "Contract" ADD CONSTRAINT contract_amounts_nonneg CHECK (amount >= 0 AND "openingPaid" >= 0 AND ("sourcePaid" IS NULL OR "sourcePaid" >= 0));
ALTER TABLE "FxRate" ADD CONSTRAINT fx_positive CHECK ("uzsPerUnit" > 0);
