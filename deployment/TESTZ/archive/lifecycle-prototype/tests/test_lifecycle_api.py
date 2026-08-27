from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lifecycle_api import (  # noqa: E402
    LifecycleConflict,
    LifecycleStore,
    ReservationRequest,
    create_app,
    validate_bind,
)


SESSION_A = "11111111-1111-4111-8111-111111111111"
SESSION_B = "22222222-2222-4222-8222-222222222222"


class Clock:
    def __init__(self, value: float = 1_722_765_600.0) -> None:
        self.value = value

    def __call__(self) -> float:
        return self.value


def operation(sequence: int, operation_id: str) -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "stationId": "station-a",
        "operationId": operation_id,
        "sequence": sequence,
    }


def report(entry_id: str = "laser-gui", mode: str = "write") -> dict[str, object]:
    return {
        "entryId": entry_id,
        "runtime": {
            "id": entry_id,
            "kind": "labview-dev",
            "model": "pid",
            "status": "running",
            "runningInstances": 1,
            "totalInstances": 1,
            "launchedAt": "2024-08-04T09:59:59Z",
            "lastSeenAt": "2024-08-04T10:00:00Z",
            "stale": False,
            "detail": "fixture",
        },
        "instances": [
            {
                "instanceId": f"{entry_id}:321:1",
                "state": "running",
                "launchMode": mode,
                "spawnedAt": "2024-08-04T09:59:59Z",
                "lastSeenAt": "2024-08-04T10:00:00Z",
            }
        ],
    }


def register(
    client: TestClient,
    session: str,
    sequence: int,
    operation_id: str,
    entry_id: str = "laser-gui",
    reservation_id: str | None = None,
    mode: str = "write",
):
    body = {**operation(sequence, operation_id), "report": report(entry_id, mode)}
    if reservation_id:
        body["reservationId"] = reservation_id
    return client.put(
        f"/api/lifecycle/v1/sessions/{session}/entries/{entry_id}", json=body
    )


def reservation(
    client: TestClient,
    session: str,
    sequence: int,
    operation_id: str,
    *,
    mode: str = "write",
    max_instances: int | None = 1,
):
    return client.post(
        "/api/lifecycle/v1/reservations",
        json={
            **operation(sequence, operation_id),
            "sessionId": session,
            "entryId": "laser-gui",
            "launchMode": mode,
            "maxInstances": max_instances,
            "writeModeExclusive": True,
        },
    )


def client_with_clock(clock: Clock | None = None, token: str | None = None) -> TestClient:
    store = LifecycleStore(clock=clock or Clock())
    return TestClient(create_app(store=store, token=token))


def test_register_query_and_own_session_exclusion() -> None:
    client = client_with_clock()
    response = register(
        client,
        SESSION_A,
        1,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    )
    assert response.status_code == 200
    assert response.json()["leaseTtlSeconds"] == 15

    visible = client.get("/api/lifecycle/v1/entries?entryId=laser-gui")
    assert visible.status_code == 200
    assert len(visible.json()["entries"]) == 1
    assert visible.json()["entries"][0]["report"]["instances"][0]["launchMode"] == "write"

    excluded = client.get(
        f"/api/lifecycle/v1/entries?entryId=laser-gui&excludeSessionId={SESSION_A}"
    )
    assert excluded.status_code == 200
    assert excluded.json()["entries"] == []


def test_strict_payload_validation_rejects_extra_fields_and_path_mismatch() -> None:
    client = client_with_clock()
    body = {
        **operation(1, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2"),
        "report": report(),
        "secretEnvironment": {"TOKEN": "not-allowed"},
    }
    assert (
        client.put(
            f"/api/lifecycle/v1/sessions/{SESSION_A}/entries/laser-gui", json=body
        ).status_code
        == 422
    )

    mismatch = {
        **operation(1, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3"),
        "report": report("another-gui"),
    }
    response = client.put(
        f"/api/lifecycle/v1/sessions/{SESSION_A}/entries/laser-gui",
        json=mismatch,
    )
    assert response.status_code == 409
    assert "does not match" in response.json()["detail"]["message"]


def test_operation_id_is_idempotent_and_stale_sequence_is_rejected() -> None:
    client = client_with_clock()
    operation_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4"
    first = register(client, SESSION_A, 1, operation_id)
    repeated = register(client, SESSION_A, 1, operation_id)
    assert repeated.status_code == 200
    assert repeated.json() == first.json()

    stale = register(
        client,
        SESSION_A,
        1,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "stale-sequence"


def test_heartbeat_replaces_the_session_snapshot_authoritatively() -> None:
    client = client_with_clock()
    assert register(
        client, SESSION_A, 1, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6", "old-gui"
    ).status_code == 200
    heartbeat = client.post(
        f"/api/lifecycle/v1/sessions/{SESSION_A}/heartbeat",
        json={
            **operation(2, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7"),
            "reports": [report("new-gui")],
        },
    )
    assert heartbeat.status_code == 200
    entries = client.get("/api/lifecycle/v1/entries").json()["entries"]
    assert [entry["report"]["entryId"] for entry in entries] == ["new-gui"]


def test_server_clock_lease_expires_crashed_client_state() -> None:
    clock = Clock()
    client = client_with_clock(clock)
    assert register(
        client, SESSION_A, 1, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8"
    ).status_code == 200
    clock.value += 16
    assert client.get("/api/lifecycle/v1/entries").json()["entries"] == []


def test_deregister_removes_entry_and_validates_schema_version() -> None:
    client = client_with_clock()
    assert register(
        client, SESSION_A, 1, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa14"
    ).status_code == 200
    params = {
        "stationId": "station-a",
        "operationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa15",
        "sequence": 2,
        "schemaVersion": 1,
    }
    removed = client.delete(
        f"/api/lifecycle/v1/sessions/{SESSION_A}/entries/laser-gui", params=params
    )
    assert removed.status_code == 200
    assert client.get("/api/lifecycle/v1/entries").json()["entries"] == []

    params["operationId"] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa16"
    params["sequence"] = 3
    params["schemaVersion"] = 2
    invalid = client.delete(
        f"/api/lifecycle/v1/sessions/{SESSION_A}/entries/laser-gui", params=params
    )
    assert invalid.status_code == 422


def test_atomic_reservation_allows_only_one_of_two_clients() -> None:
    client = client_with_clock()
    first = reservation(
        client,
        SESSION_A,
        1,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9",
    )
    second = reservation(
        client,
        SESSION_B,
        1,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
    )
    assert first.status_code == 201
    assert second.status_code == 409
    assert second.json()["detail"]["code"] == "instance-limit"


def test_reservation_store_is_atomic_under_simultaneous_coroutines() -> None:
    store = LifecycleStore(clock=Clock())
    first = ReservationRequest.model_validate(
        {
            **operation(1, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa17"),
            "sessionId": SESSION_A,
            "entryId": "laser-gui",
            "launchMode": "write",
            "maxInstances": 1,
            "writeModeExclusive": True,
        }
    )
    second = ReservationRequest.model_validate(
        {
            **operation(1, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5"),
            "sessionId": SESSION_B,
            "entryId": "laser-gui",
            "launchMode": "write",
            "maxInstances": 1,
            "writeModeExclusive": True,
        }
    )

    async def race() -> list[object]:
        return list(
            await asyncio.gather(
                store.reserve(first), store.reserve(second), return_exceptions=True
            )
        )

    outcomes = asyncio.run(race())
    assert sum(isinstance(outcome, dict) for outcome in outcomes) == 1
    conflicts = [outcome for outcome in outcomes if isinstance(outcome, LifecycleConflict)]
    assert len(conflicts) == 1
    assert conflicts[0].code == "instance-limit"


def test_expired_reservation_no_longer_blocks_replacement() -> None:
    clock = Clock()
    client = client_with_clock(clock)
    assert reservation(
        client,
        SESSION_A,
        1,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa19",
    ).status_code == 201
    clock.value += 11
    replacement = reservation(
        client,
        SESSION_B,
        1,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb7",
    )
    assert replacement.status_code == 201


def test_successful_register_commits_reservation_and_failed_launch_can_release_it() -> None:
    client = client_with_clock()
    acquired = reservation(
        client,
        SESSION_A,
        1,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10",
    )
    reservation_id = acquired.json()["reservationId"]
    committed = register(
        client,
        SESSION_A,
        2,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa11",
        reservation_id=reservation_id,
    )
    assert committed.status_code == 200
    assert (
        client.delete(
            f"/api/lifecycle/v1/reservations/{reservation_id}",
            params={"operationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa12"},
        ).status_code
        == 200
    )

    second = reservation(
        client,
        SESSION_B,
        1,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
    )
    assert second.status_code == 409


def test_authoritative_heartbeat_commits_pending_reservation_recovery() -> None:
    client = client_with_clock()
    acquired = reservation(
        client,
        SESSION_A,
        1,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa20",
    )
    assert acquired.status_code == 201
    heartbeat = client.post(
        f"/api/lifecycle/v1/sessions/{SESSION_A}/heartbeat",
        json={
            **operation(2, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa21"),
            "reports": [report()],
        },
    )
    assert heartbeat.status_code == 200
    removed = client.delete(
        f"/api/lifecycle/v1/sessions/{SESSION_A}/entries/laser-gui",
        params={
            "stationId": "station-a",
            "operationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa22",
            "sequence": 3,
            "schemaVersion": 1,
        },
    )
    assert removed.status_code == 200
    replacement = reservation(
        client,
        SESSION_B,
        1,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb8",
    )
    assert replacement.status_code == 201


def test_write_exclusivity_blocks_second_writer_without_singleton_limit() -> None:
    client = client_with_clock()
    assert register(
        client, SESSION_A, 1, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa13"
    ).status_code == 200
    blocked = reservation(
        client,
        SESSION_B,
        1,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3",
        max_instances=None,
    )
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["code"] == "write-exclusive"

    reader = reservation(
        client,
        SESSION_B,
        2,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4",
        mode="read",
        max_instances=None,
    )
    assert reader.status_code == 201


def test_unknown_requested_mode_fails_closed_when_any_instance_exists() -> None:
    client = client_with_clock()
    assert register(
        client,
        SESSION_A,
        1,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa18",
        mode="read",
    ).status_code == 200
    blocked = reservation(
        client,
        SESSION_B,
        1,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6",
        mode="unknown",
        max_instances=None,
    )
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["code"] == "write-mode-unknown"


def test_bearer_auth_and_bind_policy() -> None:
    client = client_with_clock(token="local-secret")
    assert client.get("/api/lifecycle/v1/entries").status_code == 401
    assert (
        client.get(
            "/api/lifecycle/v1/entries",
            headers={"authorization": "Bearer local-secret"},
        ).status_code
        == 200
    )
    assert client.get("/api/lifecycle/v1/health/live").status_code == 200

    validate_bind("127.0.0.1", None)
    validate_bind("::1", None)
    try:
        validate_bind("0.0.0.0", None)
    except RuntimeError as error:
        assert "ELI_HMI_LIFECYCLE_TOKEN" in str(error)
    else:
        raise AssertionError("public bind without a token must be refused")
    validate_bind("0.0.0.0", "configured")
