import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { Employee } from './employee.entity';

@Entity('balances')
@Unique(['employeeId', 'locationId', 'leaveType'])
export class Balance {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  employeeId: string;

  @Column()
  locationId: string;

  @Column()
  leaveType: string;

  @Column({ type: 'real', default: 0 })
  available: number;

  @Column({ type: 'real', default: 0 })
  total: number;

  @Column({ type: 'real', default: 0 })
  used: number;

  @Column({ type: 'integer', default: 0 })
  version: number;

  @Column({ type: 'datetime', nullable: true })
  lastSyncAt: Date;

  @ManyToOne(() => Employee, (emp) => emp.balances)
  @JoinColumn({ name: 'employeeId' })
  employee: Employee;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
