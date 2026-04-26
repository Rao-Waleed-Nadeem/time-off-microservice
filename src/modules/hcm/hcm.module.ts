import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { HcmClient } from './hcm.client';

@Module({
  imports: [HttpModule, ConfigModule],
  providers: [HcmClient],
  exports: [HcmClient],
})
export class HcmModule {}
