import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { Employee } from '../entities/employee.entity';
import { Balance } from '../entities/balance.entity';
import { TimeOffRequest } from '../entities/time-off-request.entity';
import { SyncLog } from '../entities/sync-log.entity';
import { OutboxEvent } from '../entities/outbox-event.entity';

export const getDatabaseConfig = (dbPath?: string): TypeOrmModuleOptions => {
  const location = dbPath || process.env.DATABASE_PATH || './data/timeoff.db';
  // Ensure parent directory exists so sqljs autoSave can write the file
  const dir = path.dirname(path.resolve(location));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return {
    type: 'sqljs',
    location,
    autoSave: true,
    entities: [Employee, Balance, TimeOffRequest, SyncLog, OutboxEvent],
    synchronize: true, // auto-creates schema; use migrations in prod
    logging: process.env.NODE_ENV === 'development' ? ['error'] : false,
  };
};

export const getTestDatabaseConfig = (): TypeOrmModuleOptions => ({
  type: 'sqljs',
  // in-memory for tests
  entities: [Employee, Balance, TimeOffRequest, SyncLog, OutboxEvent],
  synchronize: true,
  logging: false,
  dropSchema: true,
});
