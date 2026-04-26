import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BalancesController } from './balances.controller';
import { BalancesService } from './balances.service';
import { Balance } from '../../entities/balance.entity';
import { Employee } from '../../entities/employee.entity';
import { TimeOffRequest } from '../../entities/time-off-request.entity';
import { SyncLog } from '../../entities/sync-log.entity';
import { OutboxEvent } from '../../entities/outbox-event.entity';
import { HcmModule } from '../hcm/hcm.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Balance,
      Employee,
      TimeOffRequest,
      SyncLog,
      OutboxEvent,
    ]),
    HcmModule,
  ],
  controllers: [BalancesController],
  providers: [BalancesService],
  exports: [BalancesService],
})
export class BalancesModule {}
