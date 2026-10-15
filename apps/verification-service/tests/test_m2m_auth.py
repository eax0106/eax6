from __future__ import annotations

import asyncio

import httpx

from src.verification.m2m_auth import Auth0M2mTokenProvider


async def test_token_refresh_yields_to_concurrent_operations_and_caches_token() -> None:
    refresh_started = asyncio.Event()
    finish_refresh = asyncio.Event()
    concurrent_operation_finished = asyncio.Event()
    requests = 0

    async def token_endpoint(request: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        assert request.url == "http://127.0.0.1:8080/oauth/token"
        refresh_started.set()
        await finish_refresh.wait()
        return httpx.Response(200, json={"access_token": "test-token", "expires_in": 3600})

    client = httpx.AsyncClient(transport=httpx.MockTransport(token_endpoint))
    provider = Auth0M2mTokenProvider(
        token_url="http://127.0.0.1:8080/oauth/token",
        audience="https://model-gateway",
        client_id="client-id",
        client_secret="client-secret",
        client=client,
    )

    async def concurrent_operation() -> None:
        await refresh_started.wait()
        await asyncio.sleep(0)
        concurrent_operation_finished.set()

    try:
        refresh = asyncio.create_task(provider.metadata())
        concurrent = asyncio.create_task(concurrent_operation())
        await asyncio.wait_for(concurrent_operation_finished.wait(), timeout=2)

        assert not refresh.done()
        finish_refresh.set()
        assert await refresh == (("authorization", "Bearer test-token"),)
        await concurrent
        assert await provider.metadata() == (("authorization", "Bearer test-token"),)
        assert requests == 1
    finally:
        finish_refresh.set()
        await asyncio.gather(refresh, concurrent, return_exceptions=True)
        await client.aclose()
