import { Module } from "@nestjs/common";
import { EngineModule } from "../../engine";
import { NotificationModule } from "../notification.module";
import { EngineEventNotificationRunner } from "./engine-event-notification.runner";
import { ENGINE_EVENT_PRODUCERS } from "./engine-event-producer";
import { EngineEventSchedulerController } from "./engine-event-scheduler.controller";
import { RunFailedProducer } from "./run-failed.producer";

/**
 * Notifications for what the engine reports (D1), read as the system principal.
 * A module of its own so NotificationModule, which many modules import, does not
 * pull in the engine client and its environment.
 */
@Module({
  imports: [EngineModule, NotificationModule],
  controllers: [EngineEventSchedulerController],
  providers: [
    RunFailedProducer,
    {
      // One entry per kind of engine event that becomes a notification.
      provide: ENGINE_EVENT_PRODUCERS,
      inject: [RunFailedProducer],
      useFactory: (runFailed: RunFailedProducer) => [runFailed],
    },
    EngineEventNotificationRunner,
  ],
})
export class EngineEventNotificationModule {}
