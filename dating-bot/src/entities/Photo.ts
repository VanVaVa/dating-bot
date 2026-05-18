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

@Entity({ name: "photos" })
export class Photo {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "uuid", name: "user_id" })
  userId!: string;

  @ManyToOne(() => User, (user) => user.photos, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: Relation<User>;

  @Column({ type: "varchar", name: "s3_key", length: 512 })
  s3Key!: string;

  @Column({ type: "int", default: 0 })
  order!: number;

  @Column({ type: "boolean", name: "is_primary", default: false })
  isPrimary!: boolean;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
