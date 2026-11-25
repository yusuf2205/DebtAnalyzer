import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessGuard } from './access.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Global()
@Module({ controllers: [AuthController], providers: [AuthService, { provide: APP_GUARD, useClass: AccessGuard }], exports: [AuthService] })
export class AuthModule {}
