import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from "typeorm";
import { Interaction } from "./Interaction.js";
import { Rating } from "./Rating.js";

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

  @Column({ type: "int", nullable: true })
  age!: number | null;

  @Column({ type: "varchar", length: 32, nullable: true })
  gender!: string | null;

  @Column({ type: "varchar", length: 255, nullable: true })
  city!: string | null;

  @Column({ type: "text", nullable: true })
  interests!: string | null;

  @Column({ type: "varchar", length: 32, nullable: true, name: "preferred_gender" })
  preferredGender!: string | null;

  @Column({ type: "int", nullable: true, name: "age_min" })
  ageMin!: number | null;

  @Column({ type: "int", nullable: true, name: "age_max" })
  ageMax!: number | null;

  @Column({ type: "int", name: "completeness_score", default: 0 })
  completenessScore!: number;

  @Column({ type: "int", name: "referral_count", default: 0 })
  referralCount!: number;

  @Column({ type: "float", name: "combined_rating", default: 0 })
  combinedRating!: number;

  @OneToMany(() => Interaction, (interaction) => interaction.fromUser)
  sentInteractions!: Relation<Interaction[]>;

  @OneToMany(() => Interaction, (interaction) => interaction.toUser)
  receivedInteractions!: Relation<Interaction[]>;

  @OneToMany(() => Rating, (rating) => rating.user)
  ratings!: Relation<Rating[]>;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
