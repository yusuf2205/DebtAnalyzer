import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

@Global()
@Module({ providers: [AuditService], exports: [AuditService], controllers: [AuditController] })
export class AuditModule {}
