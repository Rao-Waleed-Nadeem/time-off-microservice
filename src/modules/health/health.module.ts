import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HcmModule } from '../hcm/hcm.module';

@Module({
  imports: [HcmModule],
  controllers: [HealthController],
})
export class HealthModule {}
