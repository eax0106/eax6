import { Module } from "@nestjs/common";
import { EngineModule } from "../../engine";
import { NotificationModule } from "../notification.module";
import { EngineEventNotificationRunner } from "./engine-event-notification.runner";
import { ENGINE_EVENT_PRODUCERS } from "./engine-event-producer";
import { ApprovalWaitingProducer } from "./approval-waiting.producer";
import { BudgetThresholdProducer } from "./budget-threshold.producer";
import { EngineEventSchedulerController } from "./engine-event-scheduler.controller";
import { RunFailedProducer } from "./run-failed.producer";
import { SelfHealProducer } from "./self-heal.producer";
import { DriftSuggestionRunner } from "./drift-suggestion.runner";

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
    ApprovalWaitingProducer,
    SelfHealProducer,
    BudgetThresholdProducer,
    {
      // One entry per kind of engine event that becomes a notification.
      provide: ENGINE_EVENT_PRODUCERS,
      inject: [RunFailedProducer, ApprovalWaitingProducer, SelfHealProducer, BudgetThresholdProducer],
      useFactory: (
        runFailed: RunFailedProducer,
        approvalWaiting: ApprovalWaitingProducer,
        selfHeal: SelfHealProducer,
        budgetThreshold: BudgetThresholdProducer,
      ) => [runFailed, approvalWaiting, selfHeal, budgetThreshold],
    },
    EngineEventNotificationRunner,
    DriftSuggestionRunner,
  ],
})
export class EngineEventNotificationModule {}
