import {
  Column,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from "typeorm";
import { User } from "./User.js";

@Entity({ name: "user_metrics" })
export class UserMetric {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "user_id", unique: true })
  userId!: string;

  @OneToOne(() => User, (user) => user.metrics, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: Relation<User>;

  @Column({ type: "int", name: "likes_received", default: 0 })
  likesReceived!: number;

  @Column({ type: "int", name: "likes_given", default: 0 })
  likesGiven!: number;

  @Column({ type: "int", name: "skips_given", default: 0 })
  skipsGiven!: number;

  @Column({ type: "int", name: "skips_received", default: 0 })
  skipsReceived!: number;

  @Column({ type: "int", default: 0 })
  matches!: number;

  @Column({ type: "int", name: "conversations_started", default: 0 })
  conversationsStarted!: number;

  @Column({ type: "float", name: "like_skip_ratio", default: 0 })
  likeSkipRatio!: number;

  @Column({ type: "jsonb", name: "activity_by_hour", default: {} })
  activityByHour!: Record<string, number>;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
