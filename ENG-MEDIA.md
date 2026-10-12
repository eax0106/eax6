# Media capabilities — removed

On 12 October 2026, the owner requested complete removal of image generation,
text-to-speech and speech-to-text. Their HTTP routes, service, provider
interfaces, mocks, AWS adapters, dedicated tests, media-check script and
configuration are removed. M3 no longer requires live media acceptance.

Shared object storage, capability resolution, Bedrock text models, Titan text
embeddings and the template spend guard remain because other components use
these facilities. Historical measurements in the work queue and memory notes
record the earlier build; they do not describe the current capability surface.
