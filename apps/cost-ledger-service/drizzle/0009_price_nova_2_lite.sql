-- Nova 2 Lite Mumbai global cross-region on-demand pricing published by AWS.
-- Price List publication: 2026-10-06T14:47:26Z.
-- https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/ap-south-1/index.json
--
-- AWS lists USD per 1,000 tokens. unit_cost_minor stores US cents per token:
--   input  $0.00035 / 1K = 0.000035 cents/token (SKU MTBSGQWRNKQ3QZC5)
--   output $0.00295 / 1K = 0.000295 cents/token (SKU 9Q9UMCGCUY6FV5HT)
INSERT INTO "model_pricing" ("provider", "model_id", "resource", "unit_cost_minor", "currency")
VALUES
  ('aws-bedrock', 'global.amazon.nova-2-lite-v1:0', 'input_tokens', 0.000035, 'USD'),
  ('aws-bedrock', 'global.amazon.nova-2-lite-v1:0', 'output_tokens', 0.000295, 'USD')
ON CONFLICT DO NOTHING;
