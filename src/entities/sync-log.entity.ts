import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';
import { SyncType, SyncStatus } from '../common/enums';

@Entity('sync_logs')
export class SyncLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: true })
  batchId: string;

  @Column({ type: 'text' })
  syncType: SyncType;

  @Column({ type: 'text' })
  status: SyncStatus;

  @Column({ type: 'integer', default: 0 })
  recordsIn: number;

  @Column({ type: 'integer', default: 0 })
  recordsUpdated: number;

  @Column({ type: 'integer', default: 0 })
  recordsFailed: number;

  @Column({ type: 'text', nullable: true })
  errorDetails: string;

  @Column({ type: 'datetime', nullable: true })
  completedAt: Date;

  @CreateDateColumn()
  startedAt: Date;
}
