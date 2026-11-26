import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { ContractsController } from './contracts/contracts.controller';
import { SuppliersController } from './suppliers/suppliers.controller';
import { GoogleClient } from './google/google-client.service';
import { GoogleController } from './google/google.controller';
import { GoogleSyncService } from './google/google-sync.service';
import { PaymentsController } from './payments/payments.controller';
import { ReconciliationController } from './reconciliation/reconciliation.controller';
import { AnalyticsService } from './analytics/analytics.service';
import { DashboardController } from './analytics/dashboard.controller';
import { ReportsController } from './reports/reports.controller';
import { ReportsService } from './reports/reports.service';
import { SystemController } from './system/system.controller';
import { CalendarController } from './calendar/calendar.controller';
import { FxController } from './fx/fx.controller';
import { HealthController } from './health/health.controller';
import { ImportsController } from './imports/imports.controller';
import { ImportsService } from './imports/imports.service';
import { PrismaModule } from './prisma/prisma.module';
import { UsersController } from './users/users.controller';

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]), PrismaModule, AuditModule, AuthModule],
  controllers: [HealthController, UsersController, ImportsController, FxController, SuppliersController, ContractsController, GoogleController, PaymentsController, ReconciliationController, CalendarController, DashboardController, ReportsController, SystemController],
  providers: [ImportsService, AnalyticsService, ReportsService, GoogleClient, GoogleSyncService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
