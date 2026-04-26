import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { getTestDatabaseConfig } from '../src/database/typeorm.config';
import { BalancesModule } from '../src/modules/balances/balances.module';
import { RequestsModule } from '../src/modules/requests/requests.module';
import { SyncModule } from '../src/modules/sync/sync.module';
import { HealthModule } from '../src/modules/health/health.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';

export async function createTestApp(): Promise<{
  app: INestApplication;
  module: TestingModule;
}> {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
      TypeOrmModule.forRoot(getTestDatabaseConfig()),
      BalancesModule,
      RequestsModule,
      SyncModule,
      HealthModule,
    ],
  }).compile();

  const app = module.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();

  return { app, module };
}
