import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import 'multer';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import mime from 'mime-types';
// @ts-ignore
import { getExtension } from 'mime';
import { IUploadProvider, RemoveFileResult, StorageFile } from './upload.interface';
import { isSafePublicHttpsUrl } from '@gitroom/nestjs-libraries/dtos/webhooks/webhook.url.validator';
import { ssrfSafeDispatcher } from '@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fromBuffer } = require('file-type');

const ALLOWED_MIME_TYPES = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/tiff',
  'video/mp4',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/ogg',
]);

class S3Storage implements IUploadProvider {
  private _client: S3Client;
  private _bucketName: string;
  private _uploadUrl: string;

  constructor(
    endpoint: string | undefined,
    accessKey: string,
    secretKey: string,
    region: string,
    bucketName: string,
    uploadUrl: string,
    forcePathStyle = true
  ) {
    const clientConfig: any = {
      region: region || 'auto',
      credentials: {
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
    };

    if (endpoint) {
      clientConfig.endpoint = endpoint;
      clientConfig.forcePathStyle = forcePathStyle;
    }

    this._client = new S3Client(clientConfig);

    // Strip problematic checksum headers for broader S3-compatible compatibility
    // (R2, some MinIO setups, and certain gateways are sensitive to these)
    this._client.middlewareStack.add(
      (next) =>
        async (args): Promise<any> => {
          const request = args.request as RequestInit;

          const headers = request.headers as Record<string, string>;
          delete headers['x-amz-checksum-crc32'];
          delete headers['x-amz-checksum-crc32c'];
          delete headers['x-amz-checksum-sha1'];
          delete headers['x-amz-checksum-sha256'];
          request.headers = headers;

          Object.entries(request.headers).forEach(
            // @ts-ignore
            ([key, value]: [string, string]): void => {
              if (!request.headers) {
                request.headers = {};
              }
              (request.headers as Record<string, string>)[key] = value;
            }
          );

          return next(args);
        },
      { step: 'build', name: 'customHeaders' }
    );

    this._bucketName = bucketName;
    // Normalize: remove trailing slash from public URL
    this._uploadUrl = uploadUrl.replace(/\/$/, '');
  }

  async uploadSimple(path: string) {
    if (!(await isSafePublicHttpsUrl(path))) {
      throw new Error('Unsafe URL');
    }
    const loadImage = await fetch(path, {
      // @ts-ignore — undici option, not in lib.dom fetch types
      dispatcher: ssrfSafeDispatcher,
    });
    const body = Buffer.from(await loadImage.arrayBuffer());
    const detected = await fromBuffer(body);
    if (!detected || !ALLOWED_MIME_TYPES.has(detected.mime)) {
      throw new Error('Unsupported file type.');
    }
    const extension = detected.ext;
    const safeContentType = detected.mime;
    const id = makeId(10);

    const params = {
      Bucket: this._bucketName,
      Key: `${id}.${extension}`,
      Body: body,
      ContentType: safeContentType,
      ChecksumMode: 'DISABLED',
    };

    const command = new PutObjectCommand({ ...params });
    await this._client.send(command);

    return `${this._uploadUrl}/${id}.${extension}`;
  }

  async uploadFile(file: Express.Multer.File): Promise<any> {
    try {
      const detected = await fromBuffer(file.buffer);
      if (!detected || !ALLOWED_MIME_TYPES.has(detected.mime)) {
        throw new Error('Unsupported file type.');
      }
      const id = makeId(10);
      const extension = detected.ext;
      const safeContentType = detected.mime;

      const command = new PutObjectCommand({
        Bucket: this._bucketName,
        // ACL is sent for compatibility with the existing Cloudflare implementation.
        // For MinIO, Megaupload-compatible, or locked-down AWS buckets, you typically
        // control public access via bucket policy instead. Set S3_SKIP_ACL=true to omit.
        ...(process.env.S3_SKIP_ACL !== 'true' ? { ACL: 'public-read' as const } : {}),
        Key: `${id}.${extension}`,
        Body: file.buffer,
        ContentType: safeContentType,
      });

      await this._client.send(command);

      return {
        filename: `${id}.${extension}`,
        mimetype: file.mimetype,
        size: file.size,
        buffer: file.buffer,
        originalname: `${id}.${extension}`,
        fieldname: 'file',
        path: `${this._uploadUrl}/${id}.${extension}`,
        destination: `${this._uploadUrl}/${id}.${extension}`,
        encoding: '7bit',
        stream: file.buffer as any,
      };
    } catch (err) {
      console.error('Error uploading file to S3-compatible storage:', err);
      throw err;
    }
  }

  /**
   * Extracts the S3 object key from a stored public URL or raw path.
   * Supports both path-style and virtual-hosted style URLs.
   */
  private extractKeyFromPath(filePath: string): string | null {
    if (!filePath) return null;

    // Strip query params and hash fragments first
    const cleanPath = filePath.split('?')[0].split('#')[0];

    try {
      const url = new URL(cleanPath);
      let key = url.pathname.replace(/^\//, '');

      // Virtual-hosted style: bucket is in the hostname (e.g. bucket.s3.amazonaws.com/key)
      if (this._bucketName && url.hostname.startsWith(this._bucketName + '.')) {
        return key || null;
      }

      // Path-style: bucket is the first path segment (common with MinIO)
      if (this._bucketName && key.startsWith(this._bucketName + '/')) {
        key = key.substring(this._bucketName.length + 1);
      }

      return key || null;
    } catch {
      // Not a valid URL — treat the input as a raw path/key
      let key = cleanPath.replace(/^\//, '');

      if (this._bucketName && key.startsWith(this._bucketName + '/')) {
        key = key.substring(this._bucketName.length + 1);
      }

      return key || null;
    }
  }

  async removeFile(filePath: string): Promise<RemoveFileResult> {
    const key = this.extractKeyFromPath(filePath);

    if (!key) {
      console.warn(`[S3Storage] Could not determine object key for removal from path: ${filePath}`);
      return 'error';
    }

    try {
      // Use HeadObject first for reliable existence check before deletion.
      await this._client.send(
        new HeadObjectCommand({
          Bucket: this._bucketName,
          Key: key,
        })
      );

      // Exists → delete it
      await this._client.send(
        new DeleteObjectCommand({
          Bucket: this._bucketName,
          Key: key,
        })
      );

      return 'removed';
    } catch (err: any) {
      const statusCode = err?.$metadata?.httpStatusCode;
      const code = err?.Code || err?.name;

      if (statusCode === 404 || code === 'NoSuchKey' || code === 'NotFound') {
        return 'not_found';
      }

      console.error(`[S3Storage] Failed to remove object "${key}" from bucket "${this._bucketName}":`, err);
      return 'error';
    }
  }

  async fileExists(filePath: string): Promise<boolean> {
    const key = this.extractKeyFromPath(filePath);
    if (!key) return false;

    try {
      await this._client.send(
        new HeadObjectCommand({
          Bucket: this._bucketName,
          Key: key,
        })
      );
      return true;
    } catch (err: any) {
      const statusCode = err?.$metadata?.httpStatusCode;
      const code = err?.Code || err?.name;
      if (statusCode === 404 || code === 'NoSuchKey' || code === 'NotFound') {
        return false;
      }
      // On other errors (network, permissions, etc.), be conservative and say it "exists" for now
      console.warn(`[S3Storage] Error checking existence of "${key}":`, err);
      return true;
    }
  }

  async listFiles(options: { prefix?: string; maxKeys?: number } = {}): Promise<StorageFile[]> {
    const { prefix = '', maxKeys = 1000 } = options;

    try {
      const command = new ListObjectsV2Command({
        Bucket: this._bucketName,
        Prefix: prefix,
        MaxKeys: maxKeys,
      });

      const response = await this._client.send(command);

      if (!response.Contents) {
        return [];
      }

      return response.Contents
        .filter((item) => item.Key) // remove folders / empty keys
        .map((item) => {
          const key = item.Key!;
          const url = `${this._uploadUrl}/${key}`;

          return {
            key,
            url,
            size: item.Size,
            lastModified: item.LastModified,
            contentType: undefined, // ListObjectsV2 doesn't return ContentType reliably
          };
        });
    } catch (err) {
      console.error('[S3Storage] Failed to list files:', err);
      return [];
    }
  }
}

export { S3Storage };
export default S3Storage;
