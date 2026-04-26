import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';
import { OutboxStatus } from '../common/enums';

@Entity('outbox_events')
export class OutboxEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  eventType: string;

  @Column({ type: 'text' })
  payload: string;

  @Column({ type: 'text', default: OutboxStatus.PENDING })
  status: OutboxStatus;

  @Column({ type: 'integer', default: 0 })
  attempts: number;

  @Column({ type: 'datetime', nullable: true })
  lastAttemptAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}
