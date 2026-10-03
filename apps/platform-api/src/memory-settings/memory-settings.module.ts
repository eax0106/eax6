import { Module } from "@nestjs/common";
import { MemorySettingsController } from "./memory-settings.controller";
import { MemorySettingsService } from "./memory-settings.service";

@Module({ controllers: [MemorySettingsController], providers: [
  { provide: MemorySettingsService, useFactory: () => new MemorySettingsService() },
], exports: [MemorySettingsService] })
export class MemorySettingsModule {}
