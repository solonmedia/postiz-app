import { HttpException, Injectable } from '@nestjs/common';
import { MediaRepository } from '@gitroom/nestjs-libraries/database/prisma/media/media.repository';
import { OpenaiService } from '@gitroom/nestjs-libraries/openai/openai.service';
import { SubscriptionService } from '@gitroom/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { Organization } from '@prisma/client';
import { SaveMediaInformationDto } from '@gitroom/nestjs-libraries/dtos/media/save.media.information.dto';
import { VideoManager } from '@gitroom/nestjs-libraries/videos/video.manager';
import { VideoDto } from '@gitroom/nestjs-libraries/dtos/videos/video.dto';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import { RemoveFileResult } from '@gitroom/nestjs-libraries/upload/upload.interface';
import {
  AuthorizationActions,
  Sections,
  SubscriptionException,
} from '@gitroom/backend/services/auth/permissions/permission.exception.class';

@Injectable()
export class MediaService {
  private storage = UploadFactory.createStorage();

  constructor(
    private _mediaRepository: MediaRepository,
    private _openAi: OpenaiService,
    private _subscriptionService: SubscriptionService,
    private _videoManager: VideoManager
  ) {}

  async deleteMedia(org: string, id: string): Promise<{ storage: RemoveFileResult }> {
    const media = await this._mediaRepository.getMediaById(id);

    let storageResult: RemoveFileResult = 'not_found';

    if (media && media.organizationId === org) {
      storageResult = await this.storage.removeFile(media.path);
    }

    await this._mediaRepository.deleteMedia(org, id);

    return { storage: storageResult };
  }

  /**
   * Checks if the file still exists in storage.
   * Returns true if we cannot confirm it is missing (conservative on transient errors).
   */
  async fileStillExists(org: string, id: string): Promise<boolean> {
    const media = await this._mediaRepository.getMediaById(id);
    if (!media || media.organizationId !== org) return false;

    if (typeof this.storage.fileExists === 'function') {
      return this.storage.fileExists(media.path);
    }

    // If the provider doesn't support existence checks, assume it still exists
    return true;
  }

  /**
   * Scans the storage for files that are not yet imported into the media library.
   * Returns information about how many new files would be imported.
   */
  async scanForImport(orgId: string, options: { prefix?: string } = {}) {
    if (typeof this.storage.listFiles !== 'function') {
      throw new Error('Current storage provider does not support listing files');
    }

    const files = await this.storage.listFiles({
      prefix: options.prefix,
      maxKeys: 1000,
    });

    let newFilesCount = 0;
    const newFiles: Array<{ key: string; url: string; size?: number }> = [];

    for (const file of files) {
      const existing = await this._mediaRepository.findByPath(file.url);
      if (!existing) {
        newFilesCount++;
        newFiles.push({
          key: file.key,
          url: file.url,
          size: file.size,
        });
      }
    }

    return {
      newFilesCount,
      newFiles: newFiles.slice(0, 50), // limit preview
    };
  }

  /**
   * Imports files that exist in the storage bucket but are not yet in the database.
   * Useful for allowing external systems to drop files directly into the bucket.
   */
  async importFromStorage(orgId: string, options: { prefix?: string } = {}) {
    if (typeof this.storage.listFiles !== 'function') {
      throw new Error('Current storage provider does not support listing files');
    }

    const files = await this.storage.listFiles({
      prefix: options.prefix,
      maxKeys: 500,
    });

    const imported: any[] = [];

    for (const file of files) {
      // Skip if we already have this file registered
      const existing = await this._mediaRepository.findByPath(file.url);
      if (existing) continue;

      const fileName = file.key.split('/').pop() || file.key;

      // Basic type detection
      const isVideo = /\.(mp4|mov|webm|avi)$/i.test(file.key);
      const type = isVideo ? 'video' : 'image';

      const created = await this._mediaRepository.saveFile(
        orgId,
        fileName,
        file.url,
        fileName
      );

      imported.push(created);
    }

    return {
      importedCount: imported.length,
      imported,
    };
  }

  getMediaById(id: string) {
    return this._mediaRepository.getMediaById(id);
  }

  async generateImage(
    prompt: string,
    org: Organization,
    generatePromptFirst?: boolean
  ) {
    const generating = await this._subscriptionService.useCredit(
      org,
      'ai_images',
      async () => {
        if (generatePromptFirst) {
          prompt = await this._openAi.generatePromptForPicture(prompt);
          console.log('Prompt:', prompt);
        }
        return this._openAi.generateImage(prompt, !!generatePromptFirst);
      }
    );

    return generating;
  }

  saveFile(org: string, fileName: string, filePath: string, originalName?: string) {
    return this._mediaRepository.saveFile(org, fileName, filePath, originalName);
  }

  getMedia(org: string, page: number, search?: string) {
    return this._mediaRepository.getMedia(org, page, search);
  }

  saveMediaInformation(org: string, data: SaveMediaInformationDto) {
    return this._mediaRepository.saveMediaInformation(org, data);
  }

  getVideoOptions() {
    return this._videoManager.getAllVideos();
  }

  async generateVideoAllowed(org: Organization, type: string) {
    const video = this._videoManager.getVideoByName(type);
    if (!video) {
      throw new Error(`Video type ${type} not found`);
    }

    if (!video.trial && org.isTrailing) {
      throw new HttpException('This video is not available in trial mode', 406);
    }

    return true;
  }

  async generateVideo(org: Organization, body: VideoDto) {
    const totalCredits = await this._subscriptionService.checkCredits(
      org,
      'ai_videos'
    );

    if (totalCredits.credits <= 0) {
      throw new SubscriptionException({
        action: AuthorizationActions.Create,
        section: Sections.VIDEOS_PER_MONTH,
      });
    }

    const video = this._videoManager.getVideoByName(body.type);
    if (!video) {
      throw new Error(`Video type ${body.type} not found`);
    }

    if (!video.trial && org.isTrailing) {
      throw new HttpException('This video is not available in trial mode', 406);
    }

    console.log(body.customParams);
    await video.instance.processAndValidate(body.customParams);
    console.log('no err');

    return await this._subscriptionService.useCredit(
      org,
      'ai_videos',
      async () => {
        const loadedData = await video.instance.process(
          body.output,
          body.customParams
        );

        const file = await this.storage.uploadSimple(loadedData);
        return this.saveFile(org.id, file.split('/').pop(), file);
      }
    );
  }

  async videoFunction(identifier: string, functionName: string, body: any) {
    const video = this._videoManager.getVideoByName(identifier);
    if (!video) {
      throw new Error(`Video with identifier ${identifier} not found`);
    }

    // @ts-ignore
    const functionToCall = video.instance[functionName];
    if (
      typeof functionToCall !== 'function' ||
      this._videoManager.checkAvailableVideoFunction(functionToCall)
    ) {
      throw new HttpException(
        `Function ${functionName} not found on video instance`,
        400
      );
    }

    return functionToCall(body);
  }
}
