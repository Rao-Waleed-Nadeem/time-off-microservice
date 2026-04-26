import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Balance } from '../../entities/balance.entity';
import { Employee } from '../../entities/employee.entity';
import { TimeOffRequest } from '../../entities/time-off-request.entity';
import { SyncLog } from '../../entities/sync-log.entity';
import { OutboxEvent } from '../../entities/outbox-event.entity';
import {
  SyncType,
  SyncStatus,
  RequestStatus,
  OutboxStatus,
  OutboxEventType,
} from '../../common/enums';
import { HcmClient } from '../hcm/hcm.client';
import { BatchSyncDto, BalanceResponseDto } from '../../common/dto/balance.dto';

@Injectable()
export class BalancesService {
  private readonly logger = new Logger(BalancesService.name);

  constructor(
    @InjectRepository(Balance)
    private readonly balanceRepo: Repository<Balance>,
    @InjectRepository(Employee)
    private readonly employeeRepo: Repository<Employee>,
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    @InjectRepository(SyncLog)
    private readonly syncLogRepo: Repository<SyncLog>,
    @InjectRepository(OutboxEvent)
    private readonly outboxRepo: Repository<OutboxEvent>,
    private readonly hcmClient: HcmClient,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Get all balances for an employee with effective available (considering pending requests)
   */
  async getEmployeeBalances(employeeId: string): Promise<BalanceResponseDto[]> {
    const employee = await this.employeeRepo.findOne({
      where: { id: employeeId },
    });
    if (!employee)
      throw new NotFoundException(`Employee ${employeeId} not found`);

    const balances = await this.balanceRepo.find({ where: { employeeId } });

    return Promise.all(balances.map((b) => this.buildBalanceResponse(b)));
  }

  /**
   * Get a single balance for employee + location + leaveType
   */
  async getBalance(
    employeeId: string,
    locationId: string,
    leaveType?: string,
  ): Promise<BalanceResponseDto[]> {
    const employee = await this.employeeRepo.findOne({
      where: { id: employeeId },
    });
    if (!employee)
      throw new NotFoundException(`Employee ${employeeId} not found`);

    const where: any = { employeeId, locationId };
    if (leaveType) where.leaveType = leaveType;

    const balances = await this.balanceRepo.find({ where });
    if (!balances.length) {
      throw new NotFoundException(
        `No balance found for employee ${employeeId} at location ${locationId}`,
      );
    }

    return Promise.all(balances.map((b) => this.buildBalanceResponse(b)));
  }

  /**
   * Build the response DTO including effective available (subtracting pending days)
   */
  private async buildBalanceResponse(
    balance: Balance,
  ): Promise<BalanceResponseDto> {
    const pendingDays = await this.getPendingDays(
      balance.employeeId,
      balance.locationId,
      balance.leaveType,
    );
    return {
      employeeId: balance.employeeId,
      locationId: balance.locationId,
      leaveType: balance.leaveType,
      available: balance.available,
      total: balance.total,
      used: balance.used,
      effectiveAvailable: Math.max(0, balance.available - pendingDays),
      pendingDays,
      lastSyncAt: balance.lastSyncAt,
      version: balance.version,
    };
  }

  /**
   * Sum of days in PENDING requests for same employee/location/leaveType
   */
  async getPendingDays(
    employeeId: string,
    locationId: string,
    leaveType: string,
  ): Promise<number> {
    const pending = await this.requestRepo.find({
      where: {
        employeeId,
        locationId,
        leaveType,
        status: RequestStatus.PENDING,
      },
    });
    return pending.reduce((sum, r) => sum + r.daysRequested, 0);
  }

  /**
   * Local pre-validation: check if balance is sufficient including pending requests
   */
  async validateSufficientBalance(
    employeeId: string,
    locationId: string,
    leaveType: string,
    daysRequested: number,
    excludeRequestId?: string,
  ): Promise<{
    valid: boolean;
    available: number;
    effective: number;
    reason?: string;
  }> {
    const balance = await this.balanceRepo.findOne({
      where: { employeeId, locationId, leaveType },
    });

    if (!balance) {
      return {
        valid: false,
        available: 0,
        effective: 0,
        reason:
          'No balance record found for this employee/location/leaveType combination',
      };
    }

    let pendingDays = await this.getPendingDays(
      employeeId,
      locationId,
      leaveType,
    );

    // If updating an existing pending request, subtract its days from the reserved pool
    if (excludeRequestId) {
      const existingReq = await this.requestRepo.findOne({
        where: { id: excludeRequestId },
      });
      if (existingReq && existingReq.status === RequestStatus.PENDING) {
        pendingDays -= existingReq.daysRequested;
      }
    }

    const effectiveAvailable = balance.available - pendingDays;

    if (daysRequested > balance.available) {
      return {
        valid: false,
        available: balance.available,
        effective: effectiveAvailable,
        reason: `Requested ${daysRequested} days but only ${balance.available} days available`,
      };
    }

    if (daysRequested > effectiveAvailable) {
      return {
        valid: false,
        available: balance.available,
        effective: effectiveAvailable,
        reason: `Requested ${daysRequested} days but only ${effectiveAvailable} effective days available (${pendingDays} days reserved for pending requests)`,
      };
    }

    return {
      valid: true,
      available: balance.available,
      effective: effectiveAvailable,
    };
  }

  /**
   * Deduct balance using optimistic locking — the core of concurrency safety
   */
  async deductBalance(
    employeeId: string,
    locationId: string,
    leaveType: string,
    days: number,
    requestId: string,
  ): Promise<Balance> {
    const MAX_RETRIES = 3;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const balance = await this.balanceRepo.findOne({
        where: { employeeId, locationId, leaveType },
      });

      if (!balance) throw new NotFoundException('Balance record not found');

      if (balance.available < days) {
        throw new UnprocessableEntityException(
          `Insufficient balance: ${balance.available} available, ${days} requested`,
        );
      }

      const result = await this.balanceRepo
        .createQueryBuilder()
        .update(Balance)
        .set({
          available: () => `available - ${days}`,
          used: () => `used + ${days}`,
          version: () => 'version + 1',
        })
        .where('id = :id AND version = :version', {
          id: balance.id,
          version: balance.version,
        })
        .execute();

      if (result.affected && result.affected > 0) {
        this.logger.log(
          `Balance deducted: ${days} days for employee ${employeeId} (attempt ${attempt + 1})`,
        );
        return this.balanceRepo.findOne({ where: { id: balance.id } });
      }

      this.logger.warn(
        `Optimistic lock conflict on balance ${balance.id}, attempt ${attempt + 1}`,
      );
      if (attempt === MAX_RETRIES - 1) {
        throw new ConflictException('Balance update conflict — please retry');
      }

      // Small delay before retry
      await new Promise((res) => setTimeout(res, 50 * (attempt + 1)));
    }
  }

  /**
   * Restore balance (on cancellation or rejection after approval)
   */
  async restoreBalance(
    employeeId: string,
    locationId: string,
    leaveType: string,
    days: number,
  ): Promise<Balance> {
    const MAX_RETRIES = 3;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const balance = await this.balanceRepo.findOne({
        where: { employeeId, locationId, leaveType },
      });
      if (!balance) throw new NotFoundException('Balance record not found');

      const result = await this.balanceRepo
        .createQueryBuilder()
        .update(Balance)
        .set({
          available: () => `MIN(total, available + ${days})`,
          used: () => `MAX(0, used - ${days})`,
          version: () => 'version + 1',
        })
        .where('id = :id AND version = :version', {
          id: balance.id,
          version: balance.version,
        })
        .execute();

      if (result.affected && result.affected > 0) {
        return this.balanceRepo.findOne({ where: { id: balance.id } });
      }

      if (attempt === MAX_RETRIES - 1) {
        throw new ConflictException('Balance restore conflict — please retry');
      }
      await new Promise((res) => setTimeout(res, 50 * (attempt + 1)));
    }
  }

  /**
   * Ingest a full batch from HCM — idempotent upsert
   */
  async ingestBatch(
    dto: BatchSyncDto,
  ): Promise<{ processed: number; skipped: number; failed: number }> {
    // Check for duplicate batchId
    const existing = await this.syncLogRepo.findOne({
      where: { batchId: dto.batchId },
    });
    if (existing) {
      this.logger.log(
        `Batch ${dto.batchId} already processed — skipping (idempotent)`,
      );
      return { processed: 0, skipped: dto.records.length, failed: 0 };
    }

    const syncLog = this.syncLogRepo.create({
      batchId: dto.batchId,
      syncType: SyncType.BATCH,
      status: SyncStatus.PARTIAL,
      recordsIn: dto.records.length,
    });
    await this.syncLogRepo.save(syncLog);

    let processed = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const record of dto.records) {
      try {
        await this.upsertBalance(
          record.employeeId,
          record.locationId,
          record.leaveType,
          {
            available: record.available,
            total: record.total,
            used: record.used,
          },
        );
        processed++;
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${record.employeeId}/${record.locationId}: ${message}`);
        this.logger.error(`Batch record failed: ${message}`);
      }
    }

    syncLog.status = failed === 0 ? SyncStatus.SUCCESS : SyncStatus.PARTIAL;
    syncLog.recordsUpdated = processed;
    syncLog.recordsFailed = failed;
    syncLog.errorDetails = errors.length ? JSON.stringify(errors) : null;
    syncLog.completedAt = new Date();
    await this.syncLogRepo.save(syncLog);

    return { processed, skipped: 0, failed };
  }

  /**
   * Upsert a balance record — used by batch ingestion and reconciliation
   */
  async upsertBalance(
    employeeId: string,
    locationId: string,
    leaveType: string,
    data: { available: number; total: number; used: number },
  ): Promise<Balance> {
    let balance = await this.balanceRepo.findOne({
      where: { employeeId, locationId, leaveType },
    });

    if (balance) {
      balance.available = data.available;
      balance.total = data.total;
      balance.used = data.used;
      balance.version = balance.version + 1;
      balance.lastSyncAt = new Date();
    } else {
      balance = this.balanceRepo.create({
        employeeId,
        locationId,
        leaveType,
        available: data.available,
        total: data.total,
        used: data.used,
        lastSyncAt: new Date(),
      });
    }

    return this.balanceRepo.save(balance);
  }

  /**
   * Force real-time sync from HCM for one employee/location/leaveType
   */
  async realtimeSync(
    employeeId: string,
    locationId: string,
    leaveType: string,
  ): Promise<BalanceResponseDto[]> {
    const employee = await this.employeeRepo.findOne({
      where: { id: employeeId },
    });
    if (!employee)
      throw new NotFoundException(`Employee ${employeeId} not found`);

    // Get all leave types for this employee+location if leaveType not specified
    const leaveTypes = leaveType
      ? [leaveType]
      : ['VACATION', 'SICK', 'PERSONAL'];

    const results: BalanceResponseDto[] = [];

    for (const lt of leaveTypes) {
      try {
        const hcmBalance = await this.hcmClient.getBalance(
          employee.externalId,
          locationId,
          lt,
        );
        await this.upsertBalance(employeeId, locationId, lt, {
          available: hcmBalance.available,
          total: hcmBalance.total,
          used: hcmBalance.used,
        });
        // Check if any pending requests would now overdraft
        await this.checkAndHandleOverdraft(
          employeeId,
          locationId,
          lt,
          hcmBalance.available,
        );
        const balance = await this.balanceRepo.findOne({
          where: { employeeId, locationId, leaveType: lt },
        });
        if (balance) results.push(await this.buildBalanceResponse(balance));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Real-time sync failed for ${employeeId}/${locationId}/${lt}: ${message}`,
        );
      }
    }

    return results;
  }

  /**
   * Reconciliation: check all balances against HCM, fix drift
   */
  async runReconciliation(): Promise<{ checked: number; corrected: number }> {
    const syncLog = this.syncLogRepo.create({
      syncType: SyncType.RECONCILIATION,
      status: SyncStatus.PARTIAL,
    });
    await this.syncLogRepo.save(syncLog);

    const employees = await this.employeeRepo.find();
    let checked = 0;
    let corrected = 0;

    for (const employee of employees) {
      const balances = await this.balanceRepo.find({
        where: { employeeId: employee.id },
      });
      for (const balance of balances) {
        try {
          const hcmBalance = await this.hcmClient.getBalance(
            employee.externalId,
            balance.locationId,
            balance.leaveType,
          );
          checked++;
          const drift = Math.abs(hcmBalance.available - balance.available);
          if (drift > 0.01) {
            this.logger.warn(
              `Balance drift detected for ${employee.id}: local=${balance.available}, HCM=${hcmBalance.available}`,
            );
            await this.upsertBalance(
              employee.id,
              balance.locationId,
              balance.leaveType,
              {
                available: hcmBalance.available,
                total: hcmBalance.total,
                used: hcmBalance.used,
              },
            );
            await this.checkAndHandleOverdraft(
              employee.id,
              balance.locationId,
              balance.leaveType,
              hcmBalance.available,
            );
            corrected++;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(
            `Reconciliation failed for ${employee.id}/${balance.locationId}: ${message}`,
          );
        }
      }
    }

    syncLog.status = SyncStatus.SUCCESS;
    syncLog.recordsIn = checked;
    syncLog.recordsUpdated = corrected;
    syncLog.completedAt = new Date();
    await this.syncLogRepo.save(syncLog);

    return { checked, corrected };
  }

  /**
   * If new HCM balance is lower than pending requests require, auto-reject overdrafted requests
   */
  private async checkAndHandleOverdraft(
    employeeId: string,
    locationId: string,
    leaveType: string,
    newAvailable: number,
  ): Promise<void> {
    const pendingRequests = await this.requestRepo.find({
      where: {
        employeeId,
        locationId,
        leaveType,
        status: RequestStatus.PENDING,
      },
      order: { createdAt: 'ASC' },
    });

    let remaining = newAvailable;
    for (const req of pendingRequests) {
      if (req.daysRequested > remaining) {
        req.status = RequestStatus.REJECTED;
        req.rejectionReason = `Auto-rejected: balance updated by HCM to ${newAvailable} days, insufficient for this request`;
        req.reviewedAt = new Date();
        await this.requestRepo.save(req);
        this.logger.warn(
          `Auto-rejected request ${req.id} due to balance reconciliation`,
        );
      } else {
        remaining -= req.daysRequested;
      }
    }
  }

  /**
   * Queue an HCM outbox event for async processing
   */
  async queueOutboxEvent(
    eventType: OutboxEventType,
    payload: object,
  ): Promise<void> {
    const event = this.outboxRepo.create({
      eventType,
      payload: JSON.stringify(payload),
      status: OutboxStatus.PENDING,
    });
    await this.outboxRepo.save(event);
  }

  /**
   * Process pending outbox events (called by scheduler)
   */
  async processOutbox(): Promise<void> {
    const pending = await this.outboxRepo.find({
      where: { status: OutboxStatus.PENDING },
      order: { createdAt: 'ASC' },
      take: 20,
    });

    for (const event of pending) {
      if (event.attempts >= 5) {
        event.status = OutboxStatus.DEAD;
        await this.outboxRepo.save(event);
        this.logger.error(
          `Outbox event ${event.id} moved to DEAD after 5 attempts`,
        );
        continue;
      }

      event.status = OutboxStatus.PROCESSING;
      event.attempts++;
      event.lastAttemptAt = new Date();
      await this.outboxRepo.save(event);

      try {
        const payload = JSON.parse(event.payload);

        if (event.eventType === OutboxEventType.HCM_DEDUCT) {
          await this.hcmClient.deductBalance(payload);
          // Mark HCM confirmed on the request
          await this.requestRepo.update(payload.requestId, {
            hcmConfirmed: true,
            hcmError: null,
          });
        } else if (event.eventType === OutboxEventType.HCM_RESTORE) {
          await this.hcmClient.restoreBalance(payload);
        }

        event.status = OutboxStatus.DONE;
        await this.outboxRepo.save(event);
      } catch (err) {
        event.status = OutboxStatus.PENDING; // back to pending for retry
        await this.outboxRepo.save(event);
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Outbox event ${event.id} failed: ${message}`);
      }
    }
  }

  async getLastSyncStatus(): Promise<SyncLog | null> {
    return this.syncLogRepo.findOne({
      where: {},
      order: { startedAt: 'DESC' },
    });
  }
}
