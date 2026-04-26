import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsArray,
  ValidateNested,
  IsOptional,
} from 'class-validator';
import { Type } from 'class-transformer';

export class BatchBalanceRecordDto {
  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @IsString()
  @IsNotEmpty()
  locationId: string;

  @IsString()
  @IsNotEmpty()
  leaveType: string;

  @IsNumber()
  @IsPositive()
  available: number;

  @IsNumber()
  @IsPositive()
  total: number;

  @IsNumber()
  used: number;
}

export class BatchSyncDto {
  @IsString()
  @IsNotEmpty()
  batchId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BatchBalanceRecordDto)
  records: BatchBalanceRecordDto[];
}

export class BalanceResponseDto {
  employeeId: string;
  locationId: string;
  leaveType: string;
  available: number;
  total: number;
  used: number;
  effectiveAvailable: number;
  pendingDays: number;
  lastSyncAt: Date | null;
  version: number;
}
