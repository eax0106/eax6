import { describe, expect, it } from "vitest";

import { temporalWorkerVersioningOptions } from "./worker";

describe("temporalWorkerVersioningOptions", () => {
  it("leaves the local development worker unversioned", () => {
    expect(
      temporalWorkerVersioningOptions({
        address: "127.0.0.1:7233",
        namespace: "default",
        taskQueue: "executor",
      }),
    ).toEqual({});
  });

  it("pins workflows to the deployment build that started them", () => {
    expect(
      temporalWorkerVersioningOptions({
        address: "cloud.temporal.io:7233",
        namespace: "engine.prod",
        taskQueue: "executor",
        workerDeployment: {
          deploymentName: "engine-workers",
          buildId: "git-sha-123",
        },
      }),
    ).toEqual({
      workerDeploymentOptions: {
        version: {
          deploymentName: "engine-workers",
          buildId: "git-sha-123",
        },
        useWorkerVersioning: true,
        defaultVersioningBehavior: "PINNED",
      },
    });
  });
});
