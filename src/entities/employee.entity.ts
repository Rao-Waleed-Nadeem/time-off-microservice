import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { Balance } from './balance.entity';
import { TimeOffRequest } from './time-off-request.entity';

@Entity('employees')
export class Employee {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  externalId: string;

  @Column()
  name: string;

  @Column({ unique: true })
  email: string;

  @Column()
  locationId: string;

  @OneToMany(() => Balance, (balance) => balance.employee)
  balances: Balance[];

  @OneToMany(() => TimeOffRequest, (req) => req.employee)
  requests: TimeOffRequest[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
