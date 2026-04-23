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

export type RatingType = "primary" | "behavioral" | "combined";

@Entity({ name: "ratings" })
@Index(["userId", "ratingType"])
export class Rating {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "uuid", name: "user_id" })
  userId!: string;

  @ManyToOne(() => User, (user) => user.ratings, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: Relation<User>;

  @Column({ type: "varchar", name: "rating_type", length: 32 })
  ratingType!: RatingType;

  @Column({ type: "float" })
  value!: number;

  @CreateDateColumn({ type: "timestamptz", name: "calculated_at" })
  calculatedAt!: Date;
}
