import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { HcmClient } from '../src/modules/hcm/hcm.client';
import { ServiceUnavailableException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { AxiosError } from 'axios';

function makeAxiosError(status: number, data: any = {}): AxiosError {
  const err = new Error('HCM error') as AxiosError;
  err.response = {
    status,
    data,
    headers: {},
    config: {} as any,
    statusText: '',
  };
  err.isAxiosError = true;
  return err;
}

describe('HcmClient', () => {
  let client: HcmClient;
  let httpService: jest.Mocked<HttpService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HcmClient,
        {
          provide: HttpService,
          useValue: {
            get: jest.fn(),
            post: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, def?: any) => {
              const config: Record<string, any> = {
                HCM_BASE_URL: 'http://localhost:4000',
                HCM_API_KEY: 'test-key',
                HCM_TIMEOUT_MS: 100,
                HCM_RETRY_ATTEMPTS: 2,
                HCM_CIRCUIT_BREAKER_THRESHOLD: 3,
              };
              return config[key] ?? def;
            }),
          },
        },
      ],
    }).compile();

    client = module.get<HcmClient>(HcmClient);
    httpService = module.get(HttpService);
  });

  describe('getBalance', () => {
    it('returns balance data on success', async () => {
      const mockBalance = {
        employeeId: 'emp1',
        locationId: 'loc1',
        leaveType: 'VACATION',
        available: 10,
        total: 15,
        used: 5,
      };
      httpService.get.mockReturnValue(of({ data: mockBalance } as any));

      const result = await client.getBalance('emp1', 'loc1', 'VACATION');
      expect(result).toEqual(mockBalance);
      expect(httpService.get).toHaveBeenCalledWith(
        'http://localhost:4000/hcm/balances/emp1/loc1/VACATION',
        expect.objectContaining({ headers: expect.any(Object) }),
      );
    });

    it('throws on 404 from HCM without retry', async () => {
      httpService.get.mockReturnValue(throwError(() => makeAxiosError(404)));

      await expect(
        client.getBalance('emp1', 'loc1', 'VACATION'),
      ).rejects.toThrow();
      // Should not retry 4xx
      expect(httpService.get).toHaveBeenCalledTimes(1);
    });

    it('retries on 500 errors up to maxRetries', async () => {
      httpService.get.mockReturnValue(throwError(() => makeAxiosError(500)));

      await expect(
        client.getBalance('emp1', 'loc1', 'VACATION'),
      ).rejects.toThrow();
      // Initial + 1 retry (maxRetries=2)
      expect(httpService.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('Circuit Breaker', () => {
    it('starts with circuit closed', () => {
      const status = client.getCircuitBreakerStatus();
      expect(status.isOpen).toBe(false);
      expect(status.consecutiveFailures).toBe(0);
    });

    it('opens circuit after threshold failures', async () => {
      httpService.get.mockReturnValue(throwError(() => makeAxiosError(500)));

      // threshold is 3, maxRetries is 2 → each call = 2 HTTP calls
      for (let i = 0; i < 3; i++) {
        await client.getBalance('emp1', 'loc1', 'VACATION').catch(() => {});
      }

      const status = client.getCircuitBreakerStatus();
      expect(status.isOpen).toBe(true);
    });

    it('throws ServiceUnavailableException when circuit is open', async () => {
      httpService.get.mockReturnValue(throwError(() => makeAxiosError(500)));

      for (let i = 0; i < 3; i++) {
        await client.getBalance('emp1', 'loc1', 'VACATION').catch(() => {});
      }

      await expect(
        client.getBalance('emp1', 'loc1', 'VACATION'),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('resets failure count on success', async () => {
      const mockBalance = {
        employeeId: 'e',
        locationId: 'l',
        leaveType: 'VACATION',
        available: 5,
        total: 10,
        used: 5,
      };
      httpService.get.mockReturnValue(of({ data: mockBalance } as any));

      await client.getBalance('emp1', 'loc1', 'VACATION');
      const status = client.getCircuitBreakerStatus();
      expect(status.consecutiveFailures).toBe(0);
    });
  });

  describe('deductBalance', () => {
    it('posts to correct endpoint with payload', async () => {
      httpService.post.mockReturnValue(of({ data: { success: true } } as any));

      const result = await client.deductBalance({
        employeeId: 'emp1',
        locationId: 'loc1',
        leaveType: 'VACATION',
        days: 3,
        requestId: 'req-1',
      });

      expect(result.success).toBe(true);
      expect(httpService.post).toHaveBeenCalledWith(
        'http://localhost:4000/hcm/balances/deduct',
        expect.objectContaining({ days: 3, requestId: 'req-1' }),
        expect.any(Object),
      );
    });
  });
});
