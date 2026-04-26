import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Employee } from './employee.entity';
import { RequestStatus } from '../common/enums';
export { RequestStatus };

@Entity('time_off_requests')
export class TimeOffRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  employeeId: string;

  @Column()
  locationId: string;

  @Column()
  leaveType: string;

  @Column({ type: 'varchar' })
  startDate: string;

  @Column({ type: 'varchar' })
  endDate: string;

  @Column({ type: 'real' })
  daysRequested: number;

  @Column({ type: 'text', default: RequestStatus.PENDING })
  status: RequestStatus;

  @Column({ nullable: true })
  notes: string;

  @Column({ nullable: true })
  reviewedBy: string;

  @Column({ type: 'datetime', nullable: true })
  reviewedAt: Date;

  @Column({ nullable: true })
  rejectionReason: string;

  @Column({ type: 'boolean', default: false })
  hcmConfirmed: boolean;

  @Column({ nullable: true })
  hcmError: string;

  @CreateDateColumn()
  requestedAt: Date;

  @ManyToOne(() => Employee, (emp) => emp.requests, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'employeeId' })
  employee: Employee;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
