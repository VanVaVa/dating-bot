import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from "typeorm";
import { User } from "./User.js";

@Entity({ name: "referrals" })
@Index(["referredId"], { unique: true })
export class Referral {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "uuid", name: "referrer_id" })
  referrerId!: string;

  @ManyToOne(() => User, (user) => user.referralsMade, { onDelete: "CASCADE" })
  @JoinColumn({ name: "referrer_id" })
  referrer!: Relation<User>;

  @Column({ type: "uuid", name: "referred_id" })
  referredId!: string;

  @ManyToOne(() => User, (user) => user.referralAccepted, { onDelete: "CASCADE" })
  @JoinColumn({ name: "referred_id" })
  referred!: Relation<User>;

  @Column({ type: "boolean", name: "bonus_awarded", default: true })
  bonusAwarded!: boolean;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
