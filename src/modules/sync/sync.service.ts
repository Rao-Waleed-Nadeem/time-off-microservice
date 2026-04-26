import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { BalancesService } from '../balances/balances.service';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly balancesService: BalancesService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Periodic reconciliation — every 15 minutes by default
   */
  @Cron(process.env.SYNC_RECONCILIATION_CRON || '*/15 * * * *', {
    name: 'reconciliation',
  })
  async runReconciliation() {
    this.logger.log('Starting scheduled reconciliation...');
    try {
      const result = await this.balancesService.runReconciliation();
      this.logger.log(
        `Reconciliation complete: ${result.checked} checked, ${result.corrected} corrected`,
      );
    } catch (err) {
      this.logger.error(`Reconciliation failed: ${err.message}`);
    }
  }

  /**
   * Process outbox — every minute
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'outbox-processor' })
  async processOutbox() {
    try {
      await this.balancesService.processOutbox();
    } catch (err) {
      this.logger.error(`Outbox processing failed: ${err.message}`);
    }
  }

  async triggerReconciliation(): Promise<{
    checked: number;
    corrected: number;
  }> {
    return this.balancesService.runReconciliation();
  }

  async getSyncStatus() {
    return this.balancesService.getLastSyncStatus();
  }
}
