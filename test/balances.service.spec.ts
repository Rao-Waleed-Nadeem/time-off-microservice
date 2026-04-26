import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { BalancesService } from '../src/modules/balances/balances.service';
import { Balance } from '../src/entities/balance.entity';
import { Employee } from '../src/entities/employee.entity';
import {
  TimeOffRequest,
  RequestStatus,
} from '../src/entities/time-off-request.entity';
import { SyncLog } from '../src/entities/sync-log.entity';
import { OutboxEvent } from '../src/entities/outbox-event.entity';
import { HcmClient } from '../src/modules/hcm/hcm.client';
import { DataSource } from 'typeorm';

const mockEmployee = {
  id: 'emp-uuid',
  externalId: 'EMP001',
  name: 'Alice',
  email: 'alice@test.com',
  locationId: 'loc-NYC',
};
const mockBalance = {
  id: 'bal-uuid',
  employeeId: 'emp-uuid',
  locationId: 'loc-NYC',
  leaveType: 'VACATION',
  available: 10,
  total: 15,
  used: 5,
  version: 0,
  lastSyncAt: new Date(),
};

function makeRepoMock() {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn((dto) => ({ ...dto })),
    save: jest.fn((entity) =>
      Promise.resolve({ id: 'generated-id', ...entity }),
    ),
    update: jest.fn(),
    createQueryBuilder: jest.fn(() => ({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    })),
  };
}

describe('BalancesService', () => {
  let service: BalancesService;
  let balanceRepo: ReturnType<typeof makeRepoMock>;
  let employeeRepo: ReturnType<typeof makeRepoMock>;
  let requestRepo: ReturnType<typeof makeRepoMock>;
  let syncLogRepo: ReturnType<typeof makeRepoMock>;
  let outboxRepo: ReturnType<typeof makeRepoMock>;
  let hcmClient: jest.Mocked<HcmClient>;

  beforeEach(async () => {
    balanceRepo = makeRepoMock();
    employeeRepo = makeRepoMock();
    requestRepo = makeRepoMock();
    syncLogRepo = makeRepoMock();
    outboxRepo = makeRepoMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BalancesService,
        { provide: getRepositoryToken(Balance), useValue: balanceRepo },
        { provide: getRepositoryToken(Employee), useValue: employeeRepo },
        { provide: getRepositoryToken(TimeOffRequest), useValue: requestRepo },
        { provide: getRepositoryToken(SyncLog), useValue: syncLogRepo },
        { provide: getRepositoryToken(OutboxEvent), useValue: outboxRepo },
        {
          provide: HcmClient,
          useValue: {
            getBalance: jest.fn(),
            deductBalance: jest.fn(),
            restoreBalance: jest.fn(),
          },
        },
        { provide: DataSource, useValue: {} },
      ],
    }).compile();

    service = module.get<BalancesService>(BalancesService);
    hcmClient = module.get(HcmClient);
  });

  describe('getEmployeeBalances', () => {
    it('returns balances with effective available', async () => {
      employeeRepo.findOne.mockResolvedValue(mockEmployee);
      balanceRepo.find.mockResolvedValue([{ ...mockBalance }]);
      requestRepo.find.mockResolvedValue([]); // no pending

      const result = await service.getEmployeeBalances('emp-uuid');

      expect(result).toHaveLength(1);
      expect(result[0].available).toBe(10);
      expect(result[0].effectiveAvailable).toBe(10);
      expect(result[0].pendingDays).toBe(0);
    });

    it('subtracts pending days from effectiveAvailable', async () => {
      employeeRepo.findOne.mockResolvedValue(mockEmployee);
      balanceRepo.find.mockResolvedValue([{ ...mockBalance }]);
      requestRepo.find.mockResolvedValue([
        { id: 'req-1', daysRequested: 3, status: RequestStatus.PENDING },
      ]);

      const result = await service.getEmployeeBalances('emp-uuid');

      expect(result[0].effectiveAvailable).toBe(7);
      expect(result[0].pendingDays).toBe(3);
    });

    it('throws NotFoundException for unknown employee', async () => {
      employeeRepo.findOne.mockResolvedValue(null);
      await expect(service.getEmployeeBalances('ghost')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('validateSufficientBalance', () => {
    it('returns valid when balance exceeds request', async () => {
      balanceRepo.findOne.mockResolvedValue({ ...mockBalance, available: 10 });
      requestRepo.find.mockResolvedValue([]);

      const result = await service.validateSufficientBalance(
        'emp-uuid',
        'loc-NYC',
        'VACATION',
        5,
      );

      expect(result.valid).toBe(true);
      expect(result.effective).toBe(10);
    });

    it('returns invalid when raw balance is insufficient', async () => {
      balanceRepo.findOne.mockResolvedValue({ ...mockBalance, available: 3 });
      requestRepo.find.mockResolvedValue([]);

      const result = await service.validateSufficientBalance(
        'emp-uuid',
        'loc-NYC',
        'VACATION',
        5,
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('3 days available');
    });

    it('returns invalid when effective balance is insufficient due to pending', async () => {
      balanceRepo.findOne.mockResolvedValue({ ...mockBalance, available: 8 });
      requestRepo.find.mockResolvedValue([
        { id: 'req-1', daysRequested: 5, status: RequestStatus.PENDING },
      ]);

      // raw=8, pending=5, effective=3, request=4 → invalid
      const result = await service.validateSufficientBalance(
        'emp-uuid',
        'loc-NYC',
        'VACATION',
        4,
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('reserved for pending requests');
    });

    it('returns invalid when no balance record exists', async () => {
      balanceRepo.findOne.mockResolvedValue(null);

      const result = await service.validateSufficientBalance(
        'emp-uuid',
        'loc-NYC',
        'VACATION',
        1,
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('No balance record found');
    });
  });

  describe('deductBalance', () => {
    it('deducts balance successfully with version check', async () => {
      balanceRepo.findOne
        .mockResolvedValueOnce({ ...mockBalance, available: 10, version: 2 })
        .mockResolvedValueOnce({ ...mockBalance, available: 7, version: 3 });

      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      balanceRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.deductBalance(
        'emp-uuid',
        'loc-NYC',
        'VACATION',
        3,
        'req-1',
      );
      expect(result.available).toBe(7);
    });

    it('retries on optimistic lock conflict and succeeds', async () => {
      balanceRepo.findOne
        .mockResolvedValueOnce({ ...mockBalance, available: 10, version: 2 })
        .mockResolvedValueOnce({ ...mockBalance, available: 10, version: 3 }) // retry read
        .mockResolvedValueOnce({ ...mockBalance, available: 7, version: 4 }); // final read

      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest
          .fn()
          .mockResolvedValueOnce({ affected: 0 }) // first attempt: lock miss
          .mockResolvedValueOnce({ affected: 1 }), // second attempt: success
      };
      balanceRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.deductBalance(
        'emp-uuid',
        'loc-NYC',
        'VACATION',
        3,
        'req-1',
      );
      expect(result.available).toBe(7);
      expect(qb.execute).toHaveBeenCalledTimes(2);
    });

    it('throws ConflictException after max retries on lock miss', async () => {
      balanceRepo.findOne.mockResolvedValue({
        ...mockBalance,
        available: 10,
        version: 2,
      });

      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      };
      balanceRepo.createQueryBuilder.mockReturnValue(qb);

      await expect(
        service.deductBalance('emp-uuid', 'loc-NYC', 'VACATION', 3, 'req-1'),
      ).rejects.toThrow(ConflictException);
    });

    it('throws UnprocessableEntityException when balance is insufficient', async () => {
      balanceRepo.findOne.mockResolvedValue({ ...mockBalance, available: 2 });

      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn(),
      };
      balanceRepo.createQueryBuilder.mockReturnValue(qb);

      await expect(
        service.deductBalance('emp-uuid', 'loc-NYC', 'VACATION', 5, 'req-1'),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('throws NotFoundException when balance record not found', async () => {
      balanceRepo.findOne.mockResolvedValue(null);

      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn(),
      };
      balanceRepo.createQueryBuilder.mockReturnValue(qb);

      await expect(
        service.deductBalance('emp-uuid', 'loc-NYC', 'VACATION', 3, 'req-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('ingestBatch', () => {
    it('processes all records and returns count', async () => {
      syncLogRepo.findOne.mockResolvedValue(null); // no existing batch
      syncLogRepo.create.mockReturnValue({ batchId: 'b1', syncType: 'BATCH' });
      syncLogRepo.save.mockResolvedValue({ id: 'log-1' });

      balanceRepo.findOne.mockResolvedValue(null); // no existing balance → create
      balanceRepo.save.mockResolvedValue({ id: 'bal-new' });

      const result = await service.ingestBatch({
        batchId: 'batch-001',
        records: [
          {
            employeeId: 'emp-1',
            locationId: 'loc-NYC',
            leaveType: 'VACATION',
            available: 10,
            total: 15,
            used: 5,
          },
          {
            employeeId: 'emp-2',
            locationId: 'loc-LA',
            leaveType: 'SICK',
            available: 7,
            total: 10,
            used: 3,
          },
        ],
      });

      expect(result.processed).toBe(2);
      expect(result.failed).toBe(0);
    });

    it('is idempotent — skips already-processed batchId', async () => {
      syncLogRepo.findOne.mockResolvedValue({
        id: 'existing-log',
        batchId: 'batch-001',
      });

      const result = await service.ingestBatch({
        batchId: 'batch-001',
        records: [
          {
            employeeId: 'emp-1',
            locationId: 'loc-NYC',
            leaveType: 'VACATION',
            available: 10,
            total: 15,
            used: 5,
          },
        ],
      });

      expect(result.processed).toBe(0);
      expect(result.skipped).toBe(1);
      expect(balanceRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('restoreBalance', () => {
    it('restores balance with version check', async () => {
      balanceRepo.findOne
        .mockResolvedValueOnce({
          ...mockBalance,
          available: 7,
          used: 8,
          total: 15,
          version: 3,
        })
        .mockResolvedValueOnce({
          ...mockBalance,
          available: 10,
          used: 5,
          version: 4,
        });

      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      balanceRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.restoreBalance(
        'emp-uuid',
        'loc-NYC',
        'VACATION',
        3,
      );
      expect(result.available).toBe(10);
    });
  });
});
