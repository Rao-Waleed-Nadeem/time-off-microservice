import { Controller, Get } from '@nestjs/common';
import { HcmClient } from '../hcm/hcm.client';

@Controller('api/v1/health')
export class HealthController {
  constructor(private readonly hcmClient: HcmClient) {}

  @Get()
  check() {
    const circuitBreaker = this.hcmClient.getCircuitBreakerStatus();
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'timeoff-microservice',
      hcm: {
        circuitBreaker: circuitBreaker.isOpen ? 'OPEN' : 'CLOSED',
        consecutiveFailures: circuitBreaker.consecutiveFailures,
      },
    };
  }
}
