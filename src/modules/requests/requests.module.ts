import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RequestsController } from './requests.controller';
import { RequestsService } from './requests.service';
import { TimeOffRequest } from '../../entities/time-off-request.entity';
import { Employee } from '../../entities/employee.entity';
import { OutboxEvent } from '../../entities/outbox-event.entity';
import { BalancesModule } from '../balances/balances.module';
import { HcmModule } from '../hcm/hcm.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([TimeOffRequest, Employee, OutboxEvent]),
    BalancesModule,
    HcmModule,
  ],
  controllers: [RequestsController],
  providers: [RequestsService],
  exports: [RequestsService],
})
export class RequestsModule {}
