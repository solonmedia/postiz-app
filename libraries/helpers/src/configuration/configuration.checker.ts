import { readFileSync, existsSync } from 'fs';
import * as dotenv from 'dotenv';
import { resolve } from 'path';

export class ConfigurationChecker {
  cfg: dotenv.DotenvParseOutput;
  issues: string[] = [];

  readEnvFromFile() {
    const envFile = resolve(__dirname, '../../../.env');

    if (!existsSync(envFile)) {
      console.error('Env file not found!: ', envFile);
      return;
    }

    const handle = readFileSync(envFile, 'utf-8');

    this.cfg = dotenv.parse(handle);
  }

  readEnvFromProcess() {
    this.cfg = process.env;
  }

  check() {
    this.checkDatabaseServers();
    this.checkNonEmpty('JWT_SECRET');
    this.checkIsValidUrl('MAIN_URL');
    this.checkIsValidUrl('FRONTEND_URL');
    this.checkIsValidUrl('NEXT_PUBLIC_BACKEND_URL');
    this.checkIsValidUrl('BACKEND_INTERNAL_URL');
    this.checkNonEmpty('STORAGE_PROVIDER', 'Needed to setup storage.');
    this.checkStorageProviderConfig();
  }

  checkNonEmpty(key: string, description?: string): boolean {
    const v = this.get(key);

    if (!description) {
      description = '';
    }

    if (!v) {
      this.issues.push(key + ' not set. ' + description);
      return false;
    }

    if (v.length === 0) {
      this.issues.push(key + ' is empty.' + description);
      return false;
    }

    return true;
  }

  get(key: string): string | undefined {
    return this.cfg[key as keyof typeof this.cfg];
  }

  checkDatabaseServers() {
    this.checkRedis();
    this.checkIsValidUrl('DATABASE_URL');
  }

  checkRedis() {
    if (!this.cfg.REDIS_URL) {
      this.issues.push('REDIS_URL not set');
    }

    try {
      const redisUrl = new URL(this.cfg.REDIS_URL);

      if (redisUrl.protocol !== 'redis:') {
        this.issues.push('REDIS_URL must start with redis://');
      }
    } catch (error) {
      this.issues.push('REDIS_URL is not a valid URL');
    }
  }

  checkIsValidUrl(key: string) {
    if (!this.checkNonEmpty(key)) {
      return;
    }

    const urlString = this.get(key);

    try {
      new URL(urlString);
    } catch (error) {
      this.issues.push(key + ' is not a valid URL');
    }

    if (urlString.endsWith('/')) {
      this.issues.push(key + ' should not end with /');
    }
  }

  checkStorageProviderConfig() {
    const provider = this.get('STORAGE_PROVIDER') || 'local';

    if (provider === 'cloudflare') {
      this.checkNonEmpty('CLOUDFLARE_ACCOUNT_ID', 'Required when STORAGE_PROVIDER=cloudflare');
      this.checkNonEmpty('CLOUDFLARE_ACCESS_KEY', 'Required when STORAGE_PROVIDER=cloudflare');
      this.checkNonEmpty('CLOUDFLARE_SECRET_ACCESS_KEY', 'Required when STORAGE_PROVIDER=cloudflare');
      this.checkNonEmpty('CLOUDFLARE_BUCKETNAME', 'Required when STORAGE_PROVIDER=cloudflare');
      this.checkNonEmpty('CLOUDFLARE_BUCKET_URL', 'Required when STORAGE_PROVIDER=cloudflare');
      this.checkNonEmpty('CLOUDFLARE_REGION', 'Required when STORAGE_PROVIDER=cloudflare');
    }

    if (provider === 's3') {
      // S3_ENDPOINT is optional (real AWS S3 doesn't need it)
      this.checkNonEmpty('S3_ACCESS_KEY', 'Required when STORAGE_PROVIDER=s3');
      this.checkNonEmpty('S3_SECRET_ACCESS_KEY', 'Required when STORAGE_PROVIDER=s3');
      this.checkNonEmpty('S3_BUCKET_NAME', 'Required when STORAGE_PROVIDER=s3');
      this.checkNonEmpty('S3_BUCKET_URL', 'Required when STORAGE_PROVIDER=s3');
    }
  }

  hasIssues() {
    return this.issues.length > 0;
  }

  getIssues() {
    return this.issues;
  }

  getIssuesCount() {
    return this.issues.length;
  }
}
