import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

@Entity({ name: "users" })
export class User {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index({ unique: true })
  @Column({ type: "bigint", name: "telegram_id" })
  telegramId!: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  username!: string | null;

  @Column({ type: "varchar", length: 255, nullable: true, name: "first_name" })
  firstName!: string | null;

  @Column({ type: "varchar", length: 255, nullable: true, name: "last_name" })
  lastName!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
