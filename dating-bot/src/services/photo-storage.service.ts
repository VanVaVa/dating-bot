import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";

export interface PhotoStorageConfig {
  bucket: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class PhotoStorageService {
  private readonly client: S3Client;

  constructor(private readonly config: PhotoStorageConfig) {
    this.client = new S3Client({
      region: "us-east-1",
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      endpoint: config.endpoint,
      forcePathStyle: Boolean(config.endpoint),
    });
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.config.bucket }));
    }
  }

  buildObjectKey(userId: string): string {
    return `photos/${userId}/${randomUUID()}.jpg`;
  }

  async uploadJpeg(key: string, body: Uint8Array): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: "image/jpeg",
      }),
    );
  }

  async getObjectBytes(key: string): Promise<Uint8Array> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      }),
    );

    const body = await response.Body?.transformToByteArray();
    if (!body) {
      throw new Error(`Пустое тело объекта MinIO для ключа "${key}".`);
    }
    return body;
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      }),
    );
  }
}
