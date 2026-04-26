import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TimeOffRequest } from '../../entities/time-off-request.entity';
import { Employee } from '../../entities/employee.entity';
import { OutboxEvent } from '../../entities/outbox-event.entity';
import {
  RequestStatus,
  OutboxStatus,
  OutboxEventType,
} from '../../common/enums';
import { BalancesService } from '../balances/balances.service';
import { HcmClient } from '../hcm/hcm.client';
import {
  CreateRequestDto,
  ApproveRequestDto,
  RejectRequestDto,
} from '../../common/dto/request.dto';
import {
  calculateBusinessDays,
  isDateTodayOrFuture,
} from '../../common/utils/date.utils';

@Injectable()
export class RequestsService {
  private readonly logger = new Logger(RequestsService.name);

  constructor(
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    @InjectRepository(Employee)
    private readonly employeeRepo: Repository<Employee>,
    @InjectRepository(OutboxEvent)
    private readonly outboxRepo: Repository<OutboxEvent>,
    private readonly balancesService: BalancesService,
    private readonly hcmClient: HcmClient,
  ) {}

  /**
   * Create a new time-off request with full local validation
   */
  async create(dto: CreateRequestDto) {
    // 1. Employee must exist
    const employee = await this.employeeRepo.findOne({
      where: { id: dto.employeeId },
    });
    if (!employee)
      throw new NotFoundException(`Employee ${dto.employeeId} not found`);

    // 2. Date validation
    if (!isDateTodayOrFuture(dto.startDate)) {
      throw new BadRequestException(
        'Start date must be today or in the future',
      );
    }
    if (dto.endDate < dto.startDate) {
      throw new BadRequestException('End date must be on or after start date');
    }

    // 3. Calculate business days
    const daysRequested = calculateBusinessDays(dto.startDate, dto.endDate);
    if (daysRequested === 0) {
      throw new BadRequestException(
        'No business days in the selected date range',
      );
    }

    // 4. Validate sufficient balance (defensive local check)
    const balanceCheck = await this.balancesService.validateSufficientBalance(
      dto.employeeId,
      dto.locationId,
      dto.leaveType,
      daysRequested,
    );

    if (!balanceCheck.valid) {
      throw new UnprocessableEntityException(balanceCheck.reason);
    }

    // 5. Create request
    const request = this.requestRepo.create({
      employeeId: dto.employeeId,
      locationId: dto.locationId,
      leaveType: dto.leaveType,
      startDate: dto.startDate,
      endDate: dto.endDate,
      daysRequested,
      notes: dto.notes,
      status: RequestStatus.PENDING,
    });

    const saved = await this.requestRepo.save(request);
    this.logger.log(
      `Request created: ${saved.id} for employee ${dto.employeeId} (${daysRequested} days)`,
    );

    return {
      id: saved.id,
      status: saved.status,
      daysRequested: saved.daysRequested,
      startDate: saved.startDate,
      endDate: saved.endDate,
      effectiveBalanceAfterApproval: balanceCheck.effective - daysRequested,
      message: 'Time-off request submitted. Awaiting manager approval.',
    };
  }

  /**
   * Approve a request: deduct local balance + call HCM (or queue to outbox)
   */
  async approve(requestId: string, dto: ApproveRequestDto) {
    const request = await this.requestRepo.findOne({
      where: { id: requestId },
    });
    if (!request) throw new NotFoundException(`Request ${requestId} not found`);
    if (request.status !== RequestStatus.PENDING) {
      throw new ConflictException(`Request is already ${request.status}`);
    }

    const employee = await this.employeeRepo.findOne({
      where: { id: request.employeeId },
    });
    if (!employee)
      throw new NotFoundException(`Employee ${request.employeeId} not found`);

    // Re-validate balance at approval time (could have changed since creation)
    const balanceCheck = await this.balancesService.validateSufficientBalance(
      request.employeeId,
      request.locationId,
      request.leaveType,
      request.daysRequested,
      requestId,
    );

    if (!balanceCheck.valid) {
      // Auto-reject because balance is now insufficient
      request.status = RequestStatus.REJECTED;
      request.rejectionReason = `Insufficient balance at approval time: ${balanceCheck.reason}`;
      request.reviewedBy = dto.reviewedBy;
      request.reviewedAt = new Date();
      await this.requestRepo.save(request);
      throw new UnprocessableEntityException(
        `Cannot approve: ${balanceCheck.reason}`,
      );
    }

    // Deduct local balance (optimistic locking)
    const updatedBalance = await this.balancesService.deductBalance(
      request.employeeId,
      request.locationId,
      request.leaveType,
      request.daysRequested,
      requestId,
    );

    // Mark request as approved
    request.status = RequestStatus.APPROVED;
    request.reviewedBy = dto.reviewedBy;
    request.reviewedAt = new Date();
    request.hcmConfirmed = false;
    await this.requestRepo.save(request);

    // Try to call HCM directly; fall back to outbox on failure
    let hcmConfirmed = false;
    let hcmError: string | null = null;

    try {
      await this.hcmClient.deductBalance({
        employeeId: employee.externalId,
        locationId: request.locationId,
        leaveType: request.leaveType,
        days: request.daysRequested,
        requestId: request.id,
      });
      hcmConfirmed = true;
      await this.requestRepo.update(requestId, { hcmConfirmed: true });
    } catch (err) {
      // Handle errors more gracefully without AxiosError import
      let status: number | undefined;
      let errorData: any;

      if (err && typeof err === 'object' && 'response' in err) {
        const response = err.response;
        status = response?.status;
        errorData = response?.data;
      }

      if (status && status >= 400 && status < 500) {
        // HCM rejected this as a business error — roll back local deduction
        await this.balancesService.restoreBalance(
          request.employeeId,
          request.locationId,
          request.leaveType,
          request.daysRequested,
        );
        request.status = RequestStatus.REJECTED;
        request.hcmError = errorData?.message || 'HCM rejected the request';
        request.rejectionReason = request.hcmError;
        await this.requestRepo.save(request);
        throw new UnprocessableEntityException(
          `HCM rejected: ${request.hcmError}`,
        );
      }

      // Network/5xx error — queue to outbox for retry
      const message = err instanceof Error ? err.message : String(err);
      hcmError = message;
      await this.queueOutboxDeduct(request, employee.externalId);
      this.logger.warn(
        `HCM call failed for request ${requestId}, queued to outbox: ${message}`,
      );
      await this.requestRepo.update(requestId, { hcmError });
    }

    return {
      id: request.id,
      status: RequestStatus.APPROVED,
      hcmConfirmed,
      hcmPending: !hcmConfirmed && !hcmError ? false : !hcmConfirmed,
      newBalance: updatedBalance.available,
      message: hcmConfirmed
        ? 'Request approved and confirmed with HCM.'
        : 'Request approved. HCM confirmation is pending (will retry automatically).',
    };
  }

  /**
   * Reject a request — balance not touched (was never deducted for PENDING)
   */
  async reject(requestId: string, dto: RejectRequestDto) {
    const request = await this.requestRepo.findOne({
      where: { id: requestId },
    });
    if (!request) throw new NotFoundException(`Request ${requestId} not found`);
    if (request.status !== RequestStatus.PENDING) {
      throw new ConflictException(`Request is already ${request.status}`);
    }

    request.status = RequestStatus.REJECTED;
    request.reviewedBy = dto.reviewedBy;
    request.reviewedAt = new Date();
    request.rejectionReason = dto.rejectionReason;
    await this.requestRepo.save(request);

    return {
      id: request.id,
      status: RequestStatus.REJECTED,
      rejectionReason: dto.rejectionReason,
    };
  }

  /**
   * Cancel a request:
   * - If PENDING: just cancel, no balance change
   * - If APPROVED: restore balance + notify HCM
   */
  async cancel(requestId: string, employeeId: string) {
    const request = await this.requestRepo.findOne({
      where: { id: requestId },
    });
    if (!request) throw new NotFoundException(`Request ${requestId} not found`);
    if (request.employeeId !== employeeId) {
      throw new ConflictException('You can only cancel your own requests');
    }
    if (
      ![RequestStatus.PENDING, RequestStatus.APPROVED].includes(request.status)
    ) {
      throw new ConflictException(
        `Cannot cancel a request with status ${request.status}`,
      );
    }

    const employee = await this.employeeRepo.findOne({
      where: { id: request.employeeId },
    });
    if (!employee)
      throw new NotFoundException(`Employee ${request.employeeId} not found`);

    const wasApproved = request.status === RequestStatus.APPROVED;
    request.status = RequestStatus.CANCELLED;
    await this.requestRepo.save(request);

    let balanceRestored = false;
    if (wasApproved) {
      // Restore local balance
      await this.balancesService.restoreBalance(
        request.employeeId,
        request.locationId,
        request.leaveType,
        request.daysRequested,
      );
      balanceRestored = true;

      // Notify HCM or queue to outbox
      try {
        await this.hcmClient.restoreBalance({
          employeeId: employee.externalId,
          locationId: request.locationId,
          leaveType: request.leaveType,
          days: request.daysRequested,
          requestId: request.id,
        });
      } catch {
        await this.queueOutboxRestore(request, employee.externalId);
        this.logger.warn(
          `HCM restore call failed for request ${requestId}, queued to outbox`,
        );
      }
    }

    return {
      id: request.id,
      status: RequestStatus.CANCELLED,
      balanceRestored,
      message: wasApproved
        ? 'Request cancelled. Balance has been restored.'
        : 'Request cancelled.',
    };
  }

  async findOne(requestId: string) {
    const request = await this.requestRepo.findOne({
      where: { id: requestId },
    });
    if (!request) throw new NotFoundException(`Request ${requestId} not found`);
    return request;
  }

  async findAll(filters: {
    employeeId?: string;
    locationId?: string;
    status?: string;
    leaveType?: string;
  }) {
    const where: any = {};
    if (filters.employeeId) where.employeeId = filters.employeeId;
    if (filters.locationId) where.locationId = filters.locationId;
    if (filters.status) where.status = filters.status;
    if (filters.leaveType) where.leaveType = filters.leaveType;

    return this.requestRepo.find({
      where,
      order: { createdAt: 'DESC' },
    });
  }

  private async queueOutboxDeduct(request: TimeOffRequest, externalId: string) {
    const event = this.outboxRepo.create({
      eventType: OutboxEventType.HCM_DEDUCT,
      payload: JSON.stringify({
        employeeId: externalId,
        locationId: request.locationId,
        leaveType: request.leaveType,
        days: request.daysRequested,
        requestId: request.id,
      }),
      status: OutboxStatus.PENDING,
    });
    await this.outboxRepo.save(event);
  }

  private async queueOutboxRestore(
    request: TimeOffRequest,
    externalId: string,
  ) {
    const event = this.outboxRepo.create({
      eventType: OutboxEventType.HCM_RESTORE,
      payload: JSON.stringify({
        employeeId: externalId,
        locationId: request.locationId,
        leaveType: request.leaveType,
        days: request.daysRequested,
        requestId: request.id,
      }),
      status: OutboxStatus.PENDING,
    });
    await this.outboxRepo.save(event);
  }
}
