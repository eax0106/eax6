import { randomUUID } from "node:crypto";

import type {
  GetEventRequest,
  GetEventResponse,
  RecordEventRequest,
  RecordEventResponse,
} from "@alterx/contracts";
import { AuditEventNotFoundError, parseAuditContext, type AuditEventHandler } from "../audit-ports";

export interface MockAuditEventHandler extends AuditEventHandler {
  getRecordedEvents(): readonly RecordEventRequest[];
}

export interface MockAuditEventHandlerOptions {
  readonly recordEvent?: (
    request: RecordEventRequest,
  ) => Promise<RecordEventResponse>;
}

function defaultRecordEvent(): RecordEventResponse {
  return {
    id: `aud_${randomUUID()}`,
    entry_hash: randomUUID().replaceAll("-", ""),
  };
}

export function createMockAuditEventHandler(
  options: MockAuditEventHandlerOptions = {},
): MockAuditEventHandler {
  const events: RecordEventRequest[] = [];
  const stored = new Map<string, { request: RecordEventRequest; response: RecordEventResponse }>();
  const recordEvent = options.recordEvent ?? (async () => defaultRecordEvent());

  return {
    recordEvent: async (request) => {
      // Refuse what the audit service refuses, so a caller's test fails
      // where production would.
      parseAuditContext(request.context_json);
      events.push({ ...request });
      const response = await recordEvent(request);
      stored.set(response.id, { request: { ...request }, response });
      return response;
    },
    getEvent: async (request: GetEventRequest): Promise<GetEventResponse> => {
      const found = stored.get(request.event_id);
      if (found === undefined || found.request.tenant_id !== request.tenant_id) {
        throw new AuditEventNotFoundError(request.event_id);
      }
      return {
        id: found.response.id,
        actor_type: found.request.actor_type,
        actor_ref: found.request.actor_ref,
        action: found.request.action,
        target_type: found.request.target_type,
        target_ref: found.request.target_ref,
        result: found.request.result,
        reason_code: found.request.reason_code,
        context_json: found.request.context_json,
        occurred_at: found.request.occurred_at,
        entry_hash: found.response.entry_hash,
      };
    },
    getRecordedEvents: () => events.map((event) => ({ ...event })),
  };
}
