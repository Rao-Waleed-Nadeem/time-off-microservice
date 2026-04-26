import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';

export interface HcmBalance {
  employeeId: string;
  locationId: string;
  leaveType: string;
  available: number;
  total: number;
  used: number;
}

export interface HcmDeductPayload {
  employeeId: string;
  locationId: string;
  leaveType: string;
  days: number;
  requestId: string;
}

export interface HcmRestorePayload {
  employeeId: string;
  locationId: string;
  leaveType: string;
  days: number;
  requestId: string;
}

export interface HcmBatchRecord {
  employeeId: string;
  locationId: string;
  leaveType: string;
  available: number;
  total: number;
  used: number;
}

@Injectable()
export class HcmClient {
  private readonly logger = new Logger(HcmClient.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly circuitBreakerThreshold: number;

  // Circuit breaker state
  private consecutiveFailures = 0;
  private circuitOpenedAt: Date | null = null;
  private readonly circuitCooldownMs = 30_000;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.baseUrl = this.configService.get<string>(
      'HCM_BASE_URL',
      'http://localhost:4000',
    );
    this.apiKey = this.configService.get<string>('HCM_API_KEY', '');
    this.timeout = this.configService.get<number>('HCM_TIMEOUT_MS', 5000);
    this.maxRetries = this.configService.get<number>('HCM_RETRY_ATTEMPTS', 3);
    this.circuitBreakerThreshold = this.configService.get<number>(
      'HCM_CIRCUIT_BREAKER_THRESHOLD',
      5,
    );
  }

  private isCircuitOpen(): boolean {
    if (!this.circuitOpenedAt) return false;
    const elapsed = Date.now() - this.circuitOpenedAt.getTime();
    if (elapsed > this.circuitCooldownMs) {
      // Half-open: allow one request through
      this.circuitOpenedAt = null;
      this.consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.circuitOpenedAt = null;
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.circuitBreakerThreshold) {
      this.circuitOpenedAt = new Date();
      this.logger.warn(
        `Circuit breaker OPEN after ${this.consecutiveFailures} consecutive failures`,
      );
    }
  }

  private getHeaders() {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
    };
  }

  private async request<T>(
    method: 'get' | 'post',
    path: string,
    data?: any,
    attempt = 1,
  ): Promise<T> {
    if (this.isCircuitOpen()) {
      throw new ServiceUnavailableException(
        'HCM service temporarily unavailable (circuit breaker open)',
      );
    }

    try {
      const observable =
        method === 'get'
          ? this.httpService.get<T>(`${this.baseUrl}${path}`, {
              headers: this.getHeaders(),
              timeout: this.timeout,
            })
          : this.httpService.post<T>(`${this.baseUrl}${path}`, data, {
              headers: this.getHeaders(),
              timeout: this.timeout,
            });

      const response = await firstValueFrom(observable);
      this.recordSuccess();
      return response.data;
    } catch (err) {
      const axiosErr = err as AxiosError;
      const status = axiosErr.response?.status;

      // Only retry on 5xx or network errors, not 4xx (those are business errors)
      if ((!status || status >= 500) && attempt < this.maxRetries) {
        const delay = Math.pow(2, attempt - 1) * 1000;
        this.logger.warn(
          `HCM request failed (attempt ${attempt}), retrying in ${delay}ms...`,
        );
        await new Promise((res) => setTimeout(res, delay));
        return this.request<T>(method, path, data, attempt + 1);
      }

      this.recordFailure();

      // Re-throw with original response for upstream to handle business errors
      throw err;
    }
  }

  async getBalance(
    employeeId: string,
    locationId: string,
    leaveType: string,
  ): Promise<HcmBalance> {
    return this.request<HcmBalance>(
      'get',
      `/hcm/balances/${employeeId}/${locationId}/${leaveType}`,
    );
  }

  async deductBalance(
    payload: HcmDeductPayload,
  ): Promise<{ success: boolean; message?: string }> {
    return this.request<{ success: boolean; message?: string }>(
      'post',
      '/hcm/balances/deduct',
      payload,
    );
  }

  async restoreBalance(
    payload: HcmRestorePayload,
  ): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(
      'post',
      '/hcm/balances/restore',
      payload,
    );
  }

  async pushBatch(
    batchId: string,
    records: HcmBatchRecord[],
  ): Promise<{ processed: number }> {
    return this.request<{ processed: number }>('post', '/hcm/balances/batch', {
      batchId,
      records,
    });
  }

  getCircuitBreakerStatus(): { isOpen: boolean; consecutiveFailures: number } {
    return {
      isOpen: this.isCircuitOpen(),
      consecutiveFailures: this.consecutiveFailures,
    };
  }
}
