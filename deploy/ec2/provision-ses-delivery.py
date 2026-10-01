"""Bind the Terraform SES rule to this host, without persisting its key in state."""
import json
import os
import re
import subprocess


def aws(operation, payload, allow_missing=False):
    # The key is supplied on stdin, never in process arguments or logs.
    result = subprocess.run(
        ["aws", "events", operation, "--cli-input-json", "file:///dev/stdin", "--output", "json"],
        input=json.dumps(payload), text=True, capture_output=True, check=False,
    )
    if result.returncode:
        if allow_missing and "ResourceNotFoundException" in result.stderr:
            return None
        raise RuntimeError(f"AWS events {operation} failed")
    return json.loads(result.stdout)


def provision(kit, domain, secret, call=aws):
    if not re.fullmatch(r"[a-zA-Z0-9.-]+", domain) or not domain or len(secret) < 32:
        raise ValueError("SES route needs a public domain and generated webhook key")
    name = kit["ruleName"]
    connection = call("describe-connection", {"Name": name}, True)
    connection = call("create-connection" if connection is None else "update-connection", {
        "Name": name, "AuthorizationType": "API_KEY",
        "AuthParameters": {"ApiKeyAuthParameters": {"ApiKeyName": "x-alter-ses-secret", "ApiKeyValue": secret}},
    })
    existing = call("describe-api-destination", {"Name": name}, True)
    destination = call("create-api-destination" if existing is None else "update-api-destination", {
        "Name": name, "ConnectionArn": connection["ConnectionArn"],
        "InvocationEndpoint": f"https://{domain}/v1/webhooks/ses", "HttpMethod": "POST",
        "InvocationRateLimitPerSecond": 100,
    })
    result = call("put-targets", {"Rule": name, "Targets": [{
        "Id": "engine-readback", "Arn": destination["ApiDestinationArn"], "RoleArn": kit["roleArn"],
        "InputPath": "$.detail", "RetryPolicy": {"MaximumEventAgeInSeconds": 86400, "MaximumRetryAttempts": 185},
        "DeadLetterConfig": {"Arn": kit["deadLetterArn"]},
    }]})
    if result.get("FailedEntryCount", 0):
        raise RuntimeError("SES rule target could not be installed")


if __name__ == "__main__":
    provision(json.loads(os.environ["SES_DELIVERY_KIT_JSON"]), os.environ["ALTER_DOMAIN"], os.environ["SES_EVENT_WEBHOOK_SECRET"])
    print("SES delivery route configured")
