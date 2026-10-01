"""No AWS calls: assert the real provisioner's create/update commands and failure path."""
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("ses_delivery", Path(__file__).with_name("provision-ses-delivery.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
kit = {"ruleName": "alter-dev-ses-delivery", "roleArn": "arn:role", "deadLetterArn": "arn:queue"}
for existing in [False, True]:
    calls = []

    def call(operation, payload, allow_missing=False):
        calls.append((operation, payload, allow_missing))
        if operation.startswith("describe-"):
            return {} if existing else None
        if operation.endswith("connection"):
            return {"ConnectionArn": "arn:connection"}
        if operation.endswith("api-destination"):
            return {"ApiDestinationArn": "arn:destination"}
        return {"FailedEntryCount": 0}

    module.provision(kit, "app.example.test", "x" * 64, call)
    action = "update" if existing else "create"
    assert [c[0] for c in calls] == ["describe-connection", f"{action}-connection", "describe-api-destination", f"{action}-api-destination", "put-targets"]
    assert calls[1][1]["AuthParameters"] == {"ApiKeyAuthParameters": {"ApiKeyName": "x-alter-ses-secret", "ApiKeyValue": "x" * 64}}
    assert calls[3][1]["InvocationEndpoint"] == "https://app.example.test/v1/webhooks/ses"
    assert calls[3][1]["ConnectionArn"] == "arn:connection"
    target = calls[4][1]["Targets"][0]
    assert target == {"Id": "engine-readback", "Arn": "arn:destination", "RoleArn": "arn:role", "InputPath": "$.detail",
                      "RetryPolicy": {"MaximumEventAgeInSeconds": 86400, "MaximumRetryAttempts": 185}, "DeadLetterConfig": {"Arn": "arn:queue"}}
    try:
        module.provision(kit, "app.example.test", "x" * 64, lambda op, payload, *args: {"FailedEntryCount": 1} if op == "put-targets" else call(op, payload, *args))
    except RuntimeError:
        pass
    else:
        raise AssertionError("Partial target failure was ignored")

calls = []
try:
    module.provision(kit, "https://invalid/path", "short", call)
except ValueError:
    assert not calls
else:
    raise AssertionError("Invalid public endpoint was accepted")

repo = Path(__file__).resolve().parents[2]
assert "handle /v1/webhooks/ses" in (repo / "deploy/ec2/Caddyfile").read_text()
assert "provision-ses-delivery.py" in (repo / "deploy/ec2/bootstrap.sh").read_text()
infra = (repo / "infrastructure/ec2-mvp/ses-delivery.tf").read_text()
for required in ['matching_event_types = ["DELIVERY", "BOUNCE"]', '"Email Delivered", "Email Bounced"', 'alter_tenant_id', 'ses:configuration-set', 'aws:SourceArn']:
    assert required in infra
print("ses-delivery-kit-passed")
