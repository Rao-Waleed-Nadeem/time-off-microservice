import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { RequestsService } from '../src/modules/requests/requests.service';
import {
  TimeOffRequest,
  RequestStatus,
} from '../src/entities/time-off-request.entity';
import { Employee } from '../src/entities/employee.entity';
import { OutboxEvent } from '../src/entities/outbox-event.entity';
import { BalancesService } from '../src/modules/balances/balances.service';
import { HcmClient } from '../src/modules/hcm/hcm.client';

const TODAY = new Date();
const FUTURE_DATE = new Date(TODAY.getTime() + 7 * 24 * 60 * 60 * 1000);
const PAST_DATE = new Date(TODAY.getTime() - 7 * 24 * 60 * 60 * 1000);

function fmtDate(d: Date) {
  return d.toISOString().split('T')[0];
}

// Monday 2025-06-02 → Friday 2025-06-06 (5 business days) as future dates
const START = '2099-06-02';
const END = '2099-06-06';

const mockEmployee = {
  id: 'emp-uuid',
  externalId: 'EMP001',
  name: 'Alice',
  email: 'alice@test.com',
  locationId: 'loc-NYC',
};

function makeRepoMock() {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn((dto) => ({ id: 'req-uuid', ...dto })),
    save: jest.fn((e) => Promise.resolve({ ...e })),
    update: jest.fn(),
  };
}

describe('RequestsService', () => {
  let service: RequestsService;
  let requestRepo: ReturnType<typeof makeRepoMock>;
  let employeeRepo: ReturnType<typeof makeRepoMock>;
  let outboxRepo: ReturnType<typeof makeRepoMock>;
  let balancesService: jest.Mocked<BalancesService>;
  let hcmClient: jest.Mocked<HcmClient>;

  beforeEach(async () => {
    requestRepo = makeRepoMock();
    employeeRepo = makeRepoMock();
    outboxRepo = makeRepoMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RequestsService,
        { provide: getRepositoryToken(TimeOffRequest), useValue: requestRepo },
        { provide: getRepositoryToken(Employee), useValue: employeeRepo },
        { provide: getRepositoryToken(OutboxEvent), useValue: outboxRepo },
        {
          provide: BalancesService,
          useValue: {
            validateSufficientBalance: jest.fn(),
            deductBalance: jest.fn(),
            restoreBalance: jest.fn(),
          },
        },
        {
          provide: HcmClient,
          useValue: {
            deductBalance: jest.fn(),
            restoreBalance: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<RequestsService>(RequestsService);
    balancesService = module.get(BalancesService);
    hcmClient = module.get(HcmClient);
  });

  // ── CREATE ───────────────────────────────────────────────────────────────

  describe('create', () => {
    const validDto = {
      employeeId: 'emp-uuid',
      locationId: 'loc-NYC',
      leaveType: 'VACATION',
      startDate: START,
      endDate: END,
    };

    it('creates a PENDING request with correct business day count', async () => {
      employeeRepo.findOne.mockResolvedValue(mockEmployee);
      (
        balancesService.validateSufficientBalance as jest.Mock
      ).mockResolvedValue({
        valid: true,
        available: 10,
        effective: 10,
      });
      requestRepo.save.mockResolvedValue({
        id: 'req-uuid',
        ...validDto,
        daysRequested: 5,
        status: RequestStatus.PENDING,
      });

      const result = await service.create(validDto);

      expect(result.status).toBe(RequestStatus.PENDING);
      expect(result.daysRequested).toBe(5);
      expect(result.message).toContain('Awaiting manager approval');
    });

    it('throws NotFoundException for unknown employee', async () => {
      employeeRepo.findOne.mockResolvedValue(null);
      await expect(service.create(validDto)).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException for past start date', async () => {
      employeeRepo.findOne.mockResolvedValue(mockEmployee);
      await expect(
        service.create({
          ...validDto,
          startDate: '2000-01-01',
          endDate: '2000-01-05',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when end date is before start date', async () => {
      employeeRepo.findOne.mockResolvedValue(mockEmployee);
      await expect(
        service.create({
          ...validDto,
          startDate: '2099-06-10',
          endDate: '2099-06-05',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when range has zero business days', async () => {
      employeeRepo.findOne.mockResolvedValue(mockEmployee);
      // Weekend only
      await expect(
        service.create({
          ...validDto,
          startDate: '2099-06-06',
          endDate: '2099-06-07',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws UnprocessableEntityException when balance insufficient', async () => {
      employeeRepo.findOne.mockResolvedValue(mockEmployee);
      (
        balancesService.validateSufficientBalance as jest.Mock
      ).mockResolvedValue({
        valid: false,
        available: 2,
        effective: 2,
        reason: 'Requested 5 days but only 2 days available',
      });

      await expect(service.create(validDto)).rejects.toThrow(
        UnprocessableEntityException,
      );
    });

    it('throws UnprocessableEntityException when effective balance insufficient due to pending', async () => {
      employeeRepo.findOne.mockResolvedValue(mockEmployee);
      (
        balancesService.validateSufficientBalance as jest.Mock
      ).mockResolvedValue({
        valid: false,
        available: 10,
        effective: 3,
        reason:
          'Only 3 effective days available (7 reserved for pending requests)',
      });

      await expect(service.create(validDto)).rejects.toThrow(
        UnprocessableEntityException,
      );
    });
  });

  // ── APPROVE ──────────────────────────────────────────────────────────────

  describe('approve', () => {
    beforeEach(() => {
      employeeRepo.findOne.mockResolvedValue(mockEmployee);
    });

    const pendingRequest = {
      id: 'req-uuid',
      employeeId: 'emp-uuid',
      locationId: 'loc-NYC',
      leaveType: 'VACATION',
      daysRequested: 3,
      status: RequestStatus.PENDING,
    };

    it('approves request, deducts balance, confirms with HCM', async () => {
      requestRepo.findOne.mockResolvedValue({ ...pendingRequest });
      (
        balancesService.validateSufficientBalance as jest.Mock
      ).mockResolvedValue({ valid: true, available: 10, effective: 10 });
      (balancesService.deductBalance as jest.Mock).mockResolvedValue({
        available: 7,
      });
      requestRepo.save.mockResolvedValue({
        ...pendingRequest,
        status: RequestStatus.APPROVED,
      });
      (hcmClient.deductBalance as jest.Mock).mockResolvedValue({
        success: true,
      });
      requestRepo.update.mockResolvedValue({ affected: 1 });

      const result = await service.approve('req-uuid', { reviewedBy: 'mgr-1' });

      expect(result.status).toBe(RequestStatus.APPROVED);
      expect(result.hcmConfirmed).toBe(true);
      expect(result.newBalance).toBe(7);
      expect(balancesService.deductBalance).toHaveBeenCalledWith(
        'emp-uuid',
        'loc-NYC',
        'VACATION',
        3,
        'req-uuid',
      );
    });

    it('queues to outbox when HCM is unavailable (5xx)', async () => {
      requestRepo.findOne.mockResolvedValue({ ...pendingRequest });
      (
        balancesService.validateSufficientBalance as jest.Mock
      ).mockResolvedValue({ valid: true, available: 10, effective: 10 });
      (balancesService.deductBalance as jest.Mock).mockResolvedValue({
        available: 7,
      });
      requestRepo.save.mockResolvedValue({
        ...pendingRequest,
        status: RequestStatus.APPROVED,
      });

      const hcmError = new Error('Network error') as any;
      hcmError.response = { status: 503 };
      (hcmClient.deductBalance as jest.Mock).mockRejectedValue(hcmError);
      outboxRepo.create.mockReturnValue({ eventType: 'HCM_DEDUCT' });
      outboxRepo.save.mockResolvedValue({ id: 'outbox-1' });
      requestRepo.update.mockResolvedValue({ affected: 1 });

      const result = await service.approve('req-uuid', { reviewedBy: 'mgr-1' });

      expect(result.status).toBe(RequestStatus.APPROVED);
      expect(result.hcmConfirmed).toBe(false);
      expect(result.hcmPending).toBe(true);
      expect(outboxRepo.save).toHaveBeenCalled();
    });

    it('rolls back local balance and rejects when HCM returns 422', async () => {
      requestRepo.findOne.mockResolvedValue({ ...pendingRequest });
      (
        balancesService.validateSufficientBalance as jest.Mock
      ).mockResolvedValue({ valid: true, available: 10, effective: 10 });
      (balancesService.deductBalance as jest.Mock).mockResolvedValue({
        available: 7,
      });
      requestRepo.save.mockResolvedValue({
        ...pendingRequest,
        status: RequestStatus.APPROVED,
      });

      const hcmError = new Error('HCM insufficient') as any;
      hcmError.response = {
        status: 422,
        data: { message: 'Insufficient balance in HCM' },
      };
      (hcmClient.deductBalance as jest.Mock).mockRejectedValue(hcmError);

      await expect(
        service.approve('req-uuid', { reviewedBy: 'mgr-1' }),
      ).rejects.toThrow(UnprocessableEntityException);
      expect(balancesService.restoreBalance).toHaveBeenCalledWith(
        'emp-uuid',
        'loc-NYC',
        'VACATION',
        3,
      );
    });

    it('throws NotFoundException for unknown request', async () => {
      requestRepo.findOne.mockResolvedValue(null);
      await expect(
        service.approve('ghost', { reviewedBy: 'mgr-1' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException when request is already APPROVED', async () => {
      requestRepo.findOne.mockResolvedValue({
        ...pendingRequest,
        status: RequestStatus.APPROVED,
      });
      await expect(
        service.approve('req-uuid', { reviewedBy: 'mgr-1' }),
      ).rejects.toThrow(ConflictException);
    });

    it('auto-rejects if balance depleted since request creation', async () => {
      requestRepo.findOne.mockResolvedValue({ ...pendingRequest });
      (
        balancesService.validateSufficientBalance as jest.Mock
      ).mockResolvedValue({
        valid: false,
        available: 1,
        effective: 1,
        reason: 'Only 1 day available',
      });
      requestRepo.save.mockResolvedValue({
        ...pendingRequest,
        status: RequestStatus.REJECTED,
      });

      await expect(
        service.approve('req-uuid', { reviewedBy: 'mgr-1' }),
      ).rejects.toThrow(UnprocessableEntityException);
      expect(balancesService.deductBalance).not.toHaveBeenCalled();
    });
  });

  // ── REJECT ───────────────────────────────────────────────────────────────

  describe('reject', () => {
    it('rejects a PENDING request without touching balance', async () => {
      requestRepo.findOne.mockResolvedValue({
        id: 'req-uuid',
        status: RequestStatus.PENDING,
      });
      requestRepo.save.mockResolvedValue({
        id: 'req-uuid',
        status: RequestStatus.REJECTED,
      });

      const result = await service.reject('req-uuid', {
        reviewedBy: 'mgr-1',
        rejectionReason: 'Team too busy',
      });

      expect(result.status).toBe(RequestStatus.REJECTED);
      expect(balancesService.deductBalance).not.toHaveBeenCalled();
      expect(balancesService.restoreBalance).not.toHaveBeenCalled();
    });

    it('throws ConflictException when trying to reject an APPROVED request', async () => {
      requestRepo.findOne.mockResolvedValue({
        id: 'req-uuid',
        status: RequestStatus.APPROVED,
      });
      await expect(
        service.reject('req-uuid', {
          reviewedBy: 'mgr-1',
          rejectionReason: 'Too late',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ── CANCEL ───────────────────────────────────────────────────────────────

  describe('cancel', () => {
    beforeEach(() => {
      employeeRepo.findOne.mockResolvedValue(mockEmployee);
    });

    it('cancels a PENDING request without restoring balance', async () => {
      requestRepo.findOne.mockResolvedValue({
        id: 'req-uuid',
        employeeId: 'emp-uuid',
        status: RequestStatus.PENDING,
        daysRequested: 3,
      });
      requestRepo.save.mockResolvedValue({
        id: 'req-uuid',
        status: RequestStatus.CANCELLED,
      });

      const result = await service.cancel('req-uuid', 'emp-uuid');

      expect(result.status).toBe(RequestStatus.CANCELLED);
      expect(result.balanceRestored).toBe(false);
      expect(balancesService.restoreBalance).not.toHaveBeenCalled();
    });

    it('cancels an APPROVED request and restores balance + notifies HCM', async () => {
      requestRepo.findOne.mockResolvedValue({
        id: 'req-uuid',
        employeeId: 'emp-uuid',
        locationId: 'loc-NYC',
        leaveType: 'VACATION',
        status: RequestStatus.APPROVED,
        daysRequested: 3,
      });
      requestRepo.save.mockResolvedValue({
        id: 'req-uuid',
        status: RequestStatus.CANCELLED,
      });
      (balancesService.restoreBalance as jest.Mock).mockResolvedValue({
        available: 10,
      });
      (hcmClient.restoreBalance as jest.Mock).mockResolvedValue({
        success: true,
      });

      const result = await service.cancel('req-uuid', 'emp-uuid');

      expect(result.status).toBe(RequestStatus.CANCELLED);
      expect(result.balanceRestored).toBe(true);
      expect(balancesService.restoreBalance).toHaveBeenCalledWith(
        'emp-uuid',
        'loc-NYC',
        'VACATION',
        3,
      );
      expect(hcmClient.restoreBalance).toHaveBeenCalled();
    });

    it('queues outbox restore when HCM call fails on cancel', async () => {
      requestRepo.findOne.mockResolvedValue({
        id: 'req-uuid',
        employeeId: 'emp-uuid',
        locationId: 'loc-NYC',
        leaveType: 'VACATION',
        status: RequestStatus.APPROVED,
        daysRequested: 3,
      });
      requestRepo.save.mockResolvedValue({
        id: 'req-uuid',
        status: RequestStatus.CANCELLED,
      });
      (balancesService.restoreBalance as jest.Mock).mockResolvedValue({
        available: 10,
      });
      (hcmClient.restoreBalance as jest.Mock).mockRejectedValue(
        new Error('HCM down'),
      );
      outboxRepo.create.mockReturnValue({ eventType: 'HCM_RESTORE' });
      outboxRepo.save.mockResolvedValue({ id: 'outbox-2' });

      const result = await service.cancel('req-uuid', 'emp-uuid');

      expect(result.balanceRestored).toBe(true);
      expect(outboxRepo.save).toHaveBeenCalled();
    });

    it('throws ConflictException when employee tries to cancel another employee request', async () => {
      requestRepo.findOne.mockResolvedValue({
        id: 'req-uuid',
        employeeId: 'emp-other',
        status: RequestStatus.PENDING,
      });
      await expect(service.cancel('req-uuid', 'emp-uuid')).rejects.toThrow(
        ConflictException,
      );
    });

    it('throws ConflictException on already-cancelled request', async () => {
      requestRepo.findOne.mockResolvedValue({
        id: 'req-uuid',
        employeeId: 'emp-uuid',
        status: RequestStatus.CANCELLED,
      });
      await expect(service.cancel('req-uuid', 'emp-uuid')).rejects.toThrow(
        ConflictException,
      );
    });
  });
});
