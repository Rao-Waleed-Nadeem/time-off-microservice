import {
  IsString,
  IsNotEmpty,
  IsDateString,
  IsOptional,
  IsEnum,
} from 'class-validator';
import { LeaveType } from '../enums';

export class CreateRequestDto {
  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @IsString()
  @IsNotEmpty()
  locationId: string;

  @IsEnum(LeaveType)
  @IsNotEmpty()
  leaveType: string;

  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class RejectRequestDto {
  @IsString()
  @IsNotEmpty()
  reviewedBy: string;

  @IsString()
  @IsNotEmpty()
  rejectionReason: string;
}

export class ApproveRequestDto {
  @IsString()
  @IsNotEmpty()
  reviewedBy: string;
}

export class ListRequestsQueryDto {
  @IsOptional()
  @IsString()
  employeeId?: string;

  @IsOptional()
  @IsString()
  locationId?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  leaveType?: string;
}
