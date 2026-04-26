import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './test-app.factory';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Employee } from '../src/entities/employee.entity';
import { Balance } from '../src/entities/balance.entity';
import {
  TimeOffRequest,
  RequestStatus,
} from '../src/entities/time-off-request.entity';
import * as http from 'http';
import { mockHcmApp } from '../mock-hcm/server';

let app: INestApplication;
let employeeRepo: Repository<Employee>;
let balanceRepo: Repository<Balance>;
let requestRepo: Repository<TimeOffRequest>;
let mockHcmServer: http.Server;
let moduleRef: any;

const MOCK_HCM_PORT = 4098;
const START = '2099-06-02'; // Monday
const END = '2099-06-04'; // Wednesday — 3 business days

async function seedEmployee(overrides: any = {}) {
  const emp = employeeRepo.create({
    externalId: `EMP-${Date.now()}`,
    name: 'Test User',
    email: `user${Date.now()}@test.com`,
    locationId: 'loc-NYC',
    ...overrides,
  });
  const saved = await employeeRepo.save(emp);
  return Array.isArray(saved) ? saved[0] : saved;
}

async function seedBalance(employeeId: string, available = 10) {
  const bal = balanceRepo.create({
    employeeId,
    locationId: 'loc-NYC',
    leaveType: 'VACATION',
    available,
    total: 15,
    used: 15 - available,
    version: 0,
  });
  return balanceRepo.save(bal);
}

async function seedHcmBalance(externalId: string, available = 10) {
  await request(mockHcmApp)
    .post('/__test/set-balance')
    .send({
      employeeId: externalId,
      locationId: 'loc-NYC',
      leaveType: 'VACATION',
      available,
      total: 15,
      used: 15 - available,
    });
}

beforeAll(async () => {
  process.env.HCM_BASE_URL = `http://localhost:${MOCK_HCM_PORT}`;
  process.env.HCM_RETRY_ATTEMPTS = '1';
  process.env.HCM_TIMEOUT_MS = '2000';

  mockHcmServer = mockHcmApp.listen(MOCK_HCM_PORT);
  const result = await createTestApp();
  app = result.app;
  moduleRef = result.module;
  employeeRepo = moduleRef.get(getRepositoryToken(Employee));
  balanceRepo = moduleRef.get(getRepositoryToken(Balance));
  requestRepo = moduleRef.get(getRepositoryToken(TimeOffRequest));
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve) => mockHcmServer.close(() => resolve()));
});

beforeEach(async () => {
  await request(mockHcmApp).post('/__test/reset');
});

// ── Create Request ────────────────────────────────────────────────────────────

describe('POST /api/v1/requests', () => {
  it('creates a PENDING request when balance is sufficient', async () => {
    const emp = await seedEmployee();
    await seedBalance(emp.id, 10);

    const res = await request(app.getHttpServer())
      .post('/api/v1/requests')
      .send({
        employeeId: emp.id,
        locationId: 'loc-NYC',
        leaveType: 'VACATION',
        startDate: START,
        endDate: END,
      })
      .expect(201);

    expect(res.body.status).toBe('PENDING');
    expect(res.body.daysRequested).toBe(3);
    expect(res.body.id).toBeDefined();
  });

  it('returns 422 when balance is insufficient', async () => {
    const emp = await seedEmployee();
    await seedBalance(emp.id, 2); // only 2 days, requesting 3

    const res = await request(app.getHttpServer())
      .post('/api/v1/requests')
      .send({
        employeeId: emp.id,
        locationId: 'loc-NYC',
        leaveType: 'VACATION',
        startDate: START,
        endDate: END,
      })
      .expect(422);

    expect(res.body.message).toContain('2 days available');
  });

  it('returns 422 when effective balance is insufficient due to pending requests', async () => {
    const emp = await seedEmployee();
    await seedBalance(emp.id, 5);

    // Create a pending request for 4 days first
    await requestRepo.save(
      requestRepo.create({
        employeeId: emp.id,
        locationId: 'loc-NYC',
        leaveType: 'VACATION',
        startDate: '2099-07-01',
        endDate: '2099-07-04',
        daysRequested: 4,
        status: RequestStatus.PENDING,
      }),
    );

    // Try to request 3 more days — effective = 5 - 4 = 1, need 3
    const res = await request(app.getHttpServer())
      .post('/api/v1/requests')
      .send({
        employeeId: emp.id,
        locationId: 'loc-NYC',
        leaveType: 'VACATION',
        startDate: START,
        endDate: END,
      })
      .expect(422);

    expect(res.body.message).toContain('reserved for pending requests');
  });

  it('returns 404 for unknown employee', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/requests')
      .send({
        employeeId: 'nonexistent',
        locationId: 'loc-NYC',
        leaveType: 'VACATION',
        startDate: START,
        endDate: END,
      })
      .expect(404);
  });

  it('returns 400 for past start date', async () => {
    const emp = await seedEmployee();
    await request(app.getHttpServer())
      .post('/api/v1/requests')
      .send({
        employeeId: emp.id,
        locationId: 'loc-NYC',
        leaveType: 'VACATION',
        startDate: '2000-01-01',
        endDate: '2000-01-05',
      })
      .expect(400);
  });

  it('returns 400 for invalid date range', async () => {
    const emp = await seedEmployee();
    await request(app.getHttpServer())
      .post('/api/v1/requests')
      .send({
        employeeId: emp.id,
        locationId: 'loc-NYC',
        leaveType: 'VACATION',
        startDate: '2099-06-10',
        endDate: '2099-06-05',
      })
      .expect(400);
  });

  it('returns 400 for missing required fields', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/requests')
      .send({ employeeId: 'emp-1' })
      .expect(400);
  });
});

// ── Approve Request ───────────────────────────────────────────────────────────

describe('PATCH /api/v1/requests/:id/approve', () => {
  it('approves request and deducts balance', async () => {
    const emp = await seedEmployee();
    await seedBalance(emp.id, 10);
    await seedHcmBalance(emp.externalId, 10);

    const createRes = await request(app.getHttpServer())
      .post('/api/v1/requests')
      .send({
        employeeId: emp.id,
        locationId: 'loc-NYC',
        leaveType: 'VACATION',
        startDate: START,
        endDate: END,
      })
      .expect(201);

    const reqId = createRes.body.id;

    const approveRes = await request(app.getHttpServer())
      .patch(`/api/v1/requests/${reqId}/approve`)
      .send({ reviewedBy: 'manager-1' })
      .expect(200);

    expect(approveRes.body.status).toBe('APPROVED');
    expect(approveRes.body.newBalance).toBe(7); // 10 - 3

    // Verify DB balance was deducted
    const bal = await balanceRepo.findOne({
      where: {
        employeeId: emp.id,
        locationId: 'loc-NYC',
        leaveType: 'VACATION',
      },
    });
    expect(bal.available).toBe(7);
    expect(bal.used).toBe(8);
  });

  it('returns 409 when trying to approve an already-approved request', async () => {
    const emp = await seedEmployee();
    await seedBalance(emp.id, 10);
    await seedHcmBalance(emp.externalId, 10);

    const createRes = await request(app.getHttpServer())
      .post('/api/v1/requests')
      .send({
        employeeId: emp.id,
        locationId: 'loc-NYC',
        leaveType: 'VACATION',
        startDate: START,
        endDate: END,
      })
      .expect(201);

    const reqId = createRes.body.id;

    await request(app.getHttpServer())
      .patch(`/api/v1/requests/${reqId}/approve`)
      .send({ reviewedBy: 'manager-1' })
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/api/v1/requests/${reqId}/approve`)
      .send({ reviewedBy: 'manager-1' })
      .expect(409);
  });

  it('returns 404 for unknown request', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/requests/ghost-id/approve')
      .send({ reviewedBy: 'manager-1' })
      .expect(404);
  });
});

// ── Reject Request ────────────────────────────────────────────────────────────

describe('PATCH /api/v1/requests/:id/reject', () => {
  it('rejects request and does not touch balance', async () => {
    const emp = await seedEmployee();
    await seedBalance(emp.id, 10);

    const createRes = await request(app.getHttpServer())
      .post('/api/v1/requests')
      .send({
        employeeId: emp.id,
        locationId: 'loc-NYC',
        leaveType: 'VACATION',
        startDate: START,
        endDate: END,
      })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/api/v1/requests/${createRes.body.id}/reject`)
      .send({
        reviewedBy: 'manager-1',
        rejectionReason: 'Business critical period',
      })
      .expect(200);

    const bal = await balanceRepo.findOne({ where: { employeeId: emp.id } });
    expect(bal.available).toBe(10); // unchanged
  });
});

// ── Cancel Request ────────────────────────────────────────────────────────────

describe('PATCH /api/v1/requests/:id/cancel', () => {
  it('cancels PENDING request without balance change', async () => {
    const emp = await seedEmployee();
    await seedBalance(emp.id, 10);

    const createRes = await request(app.getHttpServer())
      .post('/api/v1/requests')
      .send({
        employeeId: emp.id,
        locationId: 'loc-NYC',
        leaveType: 'VACATION',
        startDate: START,
        endDate: END,
      })
      .expect(201);

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/requests/${createRes.body.id}/cancel`)
      .send({ employeeId: emp.id })
      .expect(200);

    expect(res.body.status).toBe('CANCELLED');
    expect(res.body.balanceRestored).toBe(false);

    const bal = await balanceRepo.findOne({ where: { employeeId: emp.id } });
    expect(bal.available).toBe(10);
  });

  it('cancels APPROVED request and restores balance', async () => {
    const emp = await seedEmployee();
    await seedBalance(emp.id, 10);
    await seedHcmBalance(emp.externalId, 10);

    const createRes = await request(app.getHttpServer())
      .post('/api/v1/requests')
      .send({
        employeeId: emp.id,
        locationId: 'loc-NYC',
        leaveType: 'VACATION',
        startDate: START,
        endDate: END,
      })
      .expect(201);

    const reqId = createRes.body.id;

    await request(app.getHttpServer())
      .patch(`/api/v1/requests/${reqId}/approve`)
      .send({ reviewedBy: 'manager-1' })
      .expect(200);

    // Balance now at 7
    const balAfterApprove = await balanceRepo.findOne({
      where: { employeeId: emp.id },
    });
    expect(balAfterApprove.available).toBe(7);

    const cancelRes = await request(app.getHttpServer())
      .patch(`/api/v1/requests/${reqId}/cancel`)
      .send({ employeeId: emp.id })
      .expect(200);

    expect(cancelRes.body.status).toBe('CANCELLED');
    expect(cancelRes.body.balanceRestored).toBe(true);

    const balAfterCancel = await balanceRepo.findOne({
      where: { employeeId: emp.id },
    });
    expect(balAfterCancel.available).toBe(10); // restored
  });
});

// ── List Requests ─────────────────────────────────────────────────────────────

describe('GET /api/v1/requests', () => {
  it('lists all requests for an employee', async () => {
    const emp = await seedEmployee();
    await seedBalance(emp.id, 15);

    // Create two requests
    await request(app.getHttpServer())
      .post('/api/v1/requests')
      .send({
        employeeId: emp.id,
        locationId: 'loc-NYC',
        leaveType: 'VACATION',
        startDate: START,
        endDate: START,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/requests')
      .send({
        employeeId: emp.id,
        locationId: 'loc-NYC',
        leaveType: 'VACATION',
        startDate: '2099-07-01',
        endDate: '2099-07-01',
      })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/requests?employeeId=${emp.id}`)
      .expect(200);

    expect(res.body.length).toBeGreaterThanOrEqual(2);
  });

  it('filters by status', async () => {
    const emp = await seedEmployee();
    await seedBalance(emp.id, 10);

    await request(app.getHttpServer())
      .post('/api/v1/requests')
      .send({
        employeeId: emp.id,
        locationId: 'loc-NYC',
        leaveType: 'VACATION',
        startDate: START,
        endDate: START,
      })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/requests?employeeId=${emp.id}&status=PENDING`)
      .expect(200);

    expect(res.body.every((r: any) => r.status === 'PENDING')).toBe(true);
  });
});
