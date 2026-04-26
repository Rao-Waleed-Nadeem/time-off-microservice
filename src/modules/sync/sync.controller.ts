import { Controller, Get, Post, HttpCode, HttpStatus } from '@nestjs/common';
import { SyncService } from './sync.service';

@Controller('api/v1/sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Get('status')
  async getStatus() {
    return this.syncService.getSyncStatus();
  }

  @Post('trigger')
  @HttpCode(HttpStatus.OK)
  async trigger() {
    const result = await this.syncService.triggerReconciliation();
    return { message: 'Reconciliation triggered', ...result };
  }
}
