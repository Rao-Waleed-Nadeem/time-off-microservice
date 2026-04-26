import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  ValidationPipe,
} from '@nestjs/common';
import { BalancesService } from './balances.service';
import { BatchSyncDto } from '../../common/dto/balance.dto';

@Controller('api/v1/balances')
export class BalancesController {
  constructor(private readonly balancesService: BalancesService) {}

  /**
   * GET /api/v1/balances/:employeeId
   * Get all balances for an employee
   */
  @Get(':employeeId')
  async getEmployeeBalances(@Param('employeeId') employeeId: string) {
    return this.balancesService.getEmployeeBalances(employeeId);
  }

  /**
   * GET /api/v1/balances/:employeeId/:locationId?leaveType=VACATION
   * Get balance for employee + location (optionally filtered by leaveType)
   */
  @Get(':employeeId/:locationId')
  async getBalance(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
    @Query('leaveType') leaveType?: string,
  ) {
    const results = await this.balancesService.getBalance(
      employeeId,
      locationId,
      leaveType,
    );
    return leaveType ? results[0] : results;
  }

  /**
   * POST /api/v1/balances/sync/batch
   * Ingest full HCM batch balance update
   */
  @Post('sync/batch')
  @HttpCode(HttpStatus.OK)
  async ingestBatch(
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: BatchSyncDto,
  ) {
    return this.balancesService.ingestBatch(dto);
  }

  /**
   * POST /api/v1/balances/sync/realtime/:employeeId/:locationId
   * Force real-time sync for one record from HCM
   */
  @Post('sync/realtime/:employeeId/:locationId')
  @HttpCode(HttpStatus.OK)
  async realtimeSync(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
    @Query('leaveType') leaveType?: string,
  ) {
    return this.balancesService.realtimeSync(employeeId, locationId, leaveType);
  }
}
