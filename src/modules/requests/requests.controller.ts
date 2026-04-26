import {
  Controller,
  Post,
  Get,
  Patch,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  ValidationPipe,
} from '@nestjs/common';
import { RequestsService } from './requests.service';
import {
  CreateRequestDto,
  ApproveRequestDto,
  RejectRequestDto,
  ListRequestsQueryDto,
} from '../../common/dto/request.dto';

@Controller('api/v1/requests')
export class RequestsController {
  constructor(private readonly requestsService: RequestsService) {}

  /**
   * POST /api/v1/requests
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: CreateRequestDto,
  ) {
    return this.requestsService.create(dto);
  }

  /**
   * GET /api/v1/requests?employeeId=&status=&locationId=&leaveType=
   */
  @Get()
  async findAll(
    @Query(new ValidationPipe({ transform: true })) query: ListRequestsQueryDto,
  ) {
    return this.requestsService.findAll(query);
  }

  /**
   * GET /api/v1/requests/:id
   */
  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.requestsService.findOne(id);
  }

  /**
   * PATCH /api/v1/requests/:id/approve
   */
  @Patch(':id/approve')
  async approve(
    @Param('id') id: string,
    @Body(new ValidationPipe({ whitelist: true })) dto: ApproveRequestDto,
  ) {
    return this.requestsService.approve(id, dto);
  }

  /**
   * PATCH /api/v1/requests/:id/reject
   */
  @Patch(':id/reject')
  async reject(
    @Param('id') id: string,
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: RejectRequestDto,
  ) {
    return this.requestsService.reject(id, dto);
  }

  /**
   * PATCH /api/v1/requests/:id/cancel
   * Body: { employeeId }
   */
  @Patch(':id/cancel')
  async cancel(
    @Param('id') id: string,
    @Body('employeeId') employeeId: string,
  ) {
    if (!employeeId) {
      throw new Error('employeeId is required in body');
    }
    return this.requestsService.cancel(id, employeeId);
  }
}
