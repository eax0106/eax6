DELETE FROM "model_pricing"
WHERE "provider" = 'aws-bedrock'
  AND "model_id" = 'global.amazon.nova-2-lite-v1:0'
  AND "resource" IN ('input_tokens', 'output_tokens');
