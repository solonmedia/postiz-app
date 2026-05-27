export type RemoveFileResult = 'removed' | 'not_found' | 'error';

export interface StorageFile {
  key: string;                    // The object key in the bucket
  url: string;                    // Full public URL
  size?: number;
  lastModified?: Date;
  contentType?: string;
}

export interface IUploadProvider {
  uploadSimple(path: string): Promise<string>;
  uploadFile(file: Express.Multer.File): Promise<any>;
  removeFile(filePath: string): Promise<RemoveFileResult>;
  fileExists?(filePath: string): Promise<boolean>;
  listFiles?(options?: { prefix?: string; maxKeys?: number }): Promise<StorageFile[]>;
}
