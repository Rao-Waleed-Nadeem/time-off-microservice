import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import * as fs from 'fs';
import * as path from 'path';

async function bootstrap() {
  // Ensure data directory exists for SQLite
  const dataDir = path.resolve(
    process.env.DATABASE_PATH
      ? path.dirname(process.env.DATABASE_PATH)
      : './data',
  );
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'error', 'warn'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new GlobalExceptionFilter());

  app.enableCors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });

  const port = process.env.PORT || 3000;
  await app.listen(port);

  Logger.log(
    `🚀 Time-Off Microservice running on http://localhost:${port}`,
    'Bootstrap',
  );
  Logger.log(
    `📊 HCM Base URL: ${process.env.HCM_BASE_URL || 'http://localhost:4000'}`,
    'Bootstrap',
  );
}

bootstrap();
