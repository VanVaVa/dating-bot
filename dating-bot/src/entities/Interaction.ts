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

export type InteractionType = "like" | "skip" | "match";

@Entity({ name: "interactions" })
@Index(["fromUserId", "toUserId", "type"])
export class Interaction {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "uuid", name: "from_user_id" })
  fromUserId!: string;

  @ManyToOne(() => User, (user) => user.sentInteractions, { onDelete: "CASCADE" })
  @JoinColumn({ name: "from_user_id" })
  fromUser!: Relation<User>;

  @Index()
  @Column({ type: "uuid", name: "to_user_id" })
  toUserId!: string;

  @ManyToOne(() => User, (user) => user.receivedInteractions, { onDelete: "CASCADE" })
  @JoinColumn({ name: "to_user_id" })
  toUser!: Relation<User>;

  @Index()
  @Column({ type: "varchar", length: 16 })
  type!: InteractionType;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
