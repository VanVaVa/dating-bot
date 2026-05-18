import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from "typeorm";
import { Interaction } from "./Interaction.js";
import { Photo } from "./Photo.js";
import { Rating } from "./Rating.js";
import { Referral } from "./Referral.js";
import { UserMetric } from "./UserMetric.js";

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

  @Index({ unique: true })
  @Column({ type: "varchar", name: "referral_code", length: 32, nullable: true })
  referralCode!: string | null;

  @Column({ type: "uuid", name: "referred_by_id", nullable: true })
  referredById!: string | null;

  @ManyToOne(() => User, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "referred_by_id" })
  referredBy!: Relation<User | null>;

  @Column({ type: "float", name: "combined_rating", default: 0 })
  combinedRating!: number;

  @OneToMany(() => Photo, (photo) => photo.user)
  photos!: Relation<Photo[]>;

  @OneToOne(() => UserMetric, (metric) => metric.user)
  metrics!: Relation<UserMetric | null>;

  @OneToMany(() => Referral, (referral) => referral.referrer)
  referralsMade!: Relation<Referral[]>;

  @OneToOne(() => Referral, (referral) => referral.referred)
  referralAccepted!: Relation<Referral | null>;

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

  @BeforeInsert()
  ensureReferralCode(): void {
    if (!this.referralCode) {
      this.referralCode = User.generateReferralCode();
    }
  }

  static generateReferralCode(): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
    let out = "";
    for (const b of bytes) {
      out += alphabet[b % alphabet.length];
    }
    return out;
  }
}
