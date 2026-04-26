import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './test-app.factory';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Employee } from '../src/entities/employee.entity';
import { Balance } from '../src/entities/balance.entity';
import { SyncLog } from '../src/entities/sync-log.entity';
import * as http from 'http';
import { mockHcmApp } from '../mock-hcm/server';

let app: INestApplication;
let employeeRepo: Repository<Employee>;
let balanceRepo: Repository<Balance>;
let mockHcmServer: http.Server;
let moduleRef: any;

const MOCK_HCM_PORT = 4099;

async function seedEmployee(overrides = {}) {
  const emp = employeeRepo.create({
    externalId: `EMP-${Date.now()}`,
    name: 'Test User',
    email: `test-${Date.now()}@example.com`,
    locationId: 'loc-NYC',
    ...overrides,
  });
  const saved = await employeeRepo.save(emp);
  return Array.isArray(saved) ? saved[0] : saved;
}

async function seedBalance(employeeId: string, overrides = {}) {
  const bal = balanceRepo.create({
    employeeId,
    locationId: 'loc-NYC',
    leaveType: 'VACATION',
    available: 10,
    total: 15,
    used: 5,
    version: 0,
    ...overrides,
  });
  return balanceRepo.save(bal);
}

beforeAll(async () => {
  // Point HCM client to our mock
  process.env.HCM_BASE_URL = `http://localhost:${MOCK_HCM_PORT}`;
  process.env.HCM_RETRY_ATTEMPTS = '1';
  process.env.HCM_TIMEOUT_MS = '2000';

  mockHcmServer = mockHcmApp.listen(MOCK_HCM_PORT);
  const result = await createTestApp();
  app = result.app;
  moduleRef = result.module;
  employeeRepo = moduleRef.get(getRepositoryToken(Employee));
  balanceRepo = moduleRef.get(getRepositoryToken(Balance));
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve) => mockHcmServer.close(() => resolve()));
});

beforeEach(async () => {
  // Reset mock HCM state
  await request(mockHcmApp).post('/__test/reset');
});

// ── Balance Reads ─────────────────────────────────────────────────────────────

describe('GET /api/v1/balances/:employeeId', () => {
  it('returns all balances for an employee', async () => {
    const emp = await seedEmployee();
    await seedBalance(emp.id);
    await seedBalance(emp.id, {
      leaveType: 'SICK',
      available: 5,
      total: 5,
      used: 0,
    });

    const res = await request(app.getHttpServer())
      .get(`/api/v1/balances/${emp.id}`)
      .expect(200);

    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toHaveProperty('effectiveAvailable');
    expect(res.body[0]).toHaveProperty('pendingDays');
  });

  it('returns 404 for unknown employee', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/balances/nonexistent-uuid')
      .expect(404);
  });
});

describe('GET /api/v1/balances/:employeeId/:locationId', () => {
  it('returns balance for specific employee and location', async () => {
    const emp = await seedEmployee();
    await seedBalance(emp.id);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/balances/${emp.id}/loc-NYC`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].available).toBe(10);
    expect(res.body[0].locationId).toBe('loc-NYC');
  });

  it('filters by leaveType when query param provided', async () => {
    const emp = await seedEmployee();
    await seedBalance(emp.id, { leaveType: 'VACATION' });
    await seedBalance(emp.id, {
      leaveType: 'SICK',
      available: 5,
      total: 5,
      used: 0,
    });

    const res = await request(app.getHttpServer())
      .get(`/api/v1/balances/${emp.id}/loc-NYC?leaveType=VACATION`)
      .expect(200);

    expect(res.body.leaveType).toBe('VACATION');
  });
});

// ── Batch Sync ────────────────────────────────────────────────────────────────

describe('POST /api/v1/balances/sync/batch', () => {
  it('processes batch and upserts balances', async () => {
    const emp = await seedEmployee();

    const res = await request(app.getHttpServer())
      .post('/api/v1/balances/sync/batch')
      .send({
        batchId: 'batch-integration-001',
        records: [
          {
            employeeId: emp.id,
            locationId: 'loc-NYC',
            leaveType: 'VACATION',
            available: 12,
            total: 15,
            used: 3,
          },
        ],
      })
      .expect(200);

    expect(res.body.processed).toBe(1);
    expect(res.body.failed).toBe(0);

    // Verify DB was updated
    const bal = await balanceRepo.findOne({
      where: {
        employeeId: emp.id,
        locationId: 'loc-NYC',
        leaveType: 'VACATION',
      },
    });
    expect(bal.available).toBe(12);
  });

  it('is idempotent — same batchId processed twice returns 0 processed', async () => {
    const emp = await seedEmployee({
      externalId: 'EMP-IDEM',
      email: 'idem@test.com',
    });

    const body = {
      batchId: 'batch-idempotent-001',
      records: [
        {
          employeeId: emp.id,
          locationId: 'loc-NYC',
          leaveType: 'VACATION',
          available: 10,
          total: 15,
          used: 5,
        },
      ],
    };

    const first = await request(app.getHttpServer())
      .post('/api/v1/balances/sync/batch')
      .send(body)
      .expect(200);

    expect(first.body.processed).toBe(1);

    const second = await request(app.getHttpServer())
      .post('/api/v1/balances/sync/batch')
      .send(body)
      .expect(200);

    expect(second.body.processed).toBe(0);
    expect(second.body.skipped).toBe(1);
  });

  it('returns 400 for missing batchId', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/balances/sync/batch')
      .send({ records: [] })
      .expect(400);
  });

  it('returns 400 for missing records array', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/balances/sync/batch')
      .send({ batchId: 'test' })
      .expect(400);
  });
});

// ── Real-time Sync ────────────────────────────────────────────────────────────

describe('POST /api/v1/balances/sync/realtime/:employeeId/:locationId', () => {
  it('fetches balance from HCM and updates local record', async () => {
    const emp = await seedEmployee();
    await seedBalance(emp.id, { available: 5 }); // stale local

    // Seed HCM with updated value
    await request(mockHcmApp).post('/__test/set-balance').send({
      employeeId: emp.externalId,
      locationId: 'loc-NYC',
      leaveType: 'VACATION',
      available: 13,
      total: 15,
      used: 2,
    });

    await request(app.getHttpServer())
      .post(
        `/api/v1/balances/sync/realtime/${emp.id}/loc-NYC?leaveType=VACATION`,
      )
      .expect(200);

    const bal = await balanceRepo.findOne({
      where: {
        employeeId: emp.id,
        locationId: 'loc-NYC',
        leaveType: 'VACATION',
      },
    });
    expect(bal.available).toBe(13);
  });
});
