"""Executable local contract for launcher lifecycle coordination.

This service is intentionally separate from the ELI HMI EPICS gateway. Its
wire shape is local acceptance data, not a claim about a site-owned API.
"""

from __future__ import annotations

import asyncio
import ipaddress
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Annotated, Callable, Literal
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, Header, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field, model_validator


API_PREFIX = "/api/lifecycle/v1"
SCHEMA_VERSION = 1
ENTRY_LEASE_SECONDS = 15
RESERVATION_LEASE_SECONDS = 10
OPERATION_CACHE_SECONDS = 120


def utc_iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace("+00:00", "Z")


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RuntimeState(StrictModel):
    id: str = Field(min_length=1)
    kind: Literal["process", "web", "folder", "labview-dev", "labview-epics", "phoebus"]
    model: Literal["pid", "phoebus-port", "external-handoff"]
    status: Literal["running", "stopped", "shared", "handed-off", "unknown"]
    runningInstances: int = Field(ge=0)
    totalInstances: int = Field(ge=0)
    launchedAt: datetime
    lastSeenAt: datetime | None = None
    stale: bool
    detail: str


class InstanceReport(StrictModel):
    instanceId: str = Field(min_length=1)
    state: Literal["running", "stopped", "unknown"]
    launchMode: Literal["read", "write", "unknown"]
    spawnedAt: datetime
    lastSeenAt: datetime | None = None


class EntryReport(StrictModel):
    entryId: str = Field(min_length=1)
    runtime: RuntimeState
    instances: list[InstanceReport]

    @model_validator(mode="after")
    def ids_match(self) -> "EntryReport":
        if self.runtime.id != self.entryId:
            raise ValueError("runtime.id must match entryId")
        return self


class CommonMutation(StrictModel):
    schemaVersion: Literal[SCHEMA_VERSION]
    stationId: str = Field(min_length=1)
    operationId: UUID
    sequence: int = Field(ge=1)


class RegisterRequest(CommonMutation):
    report: EntryReport
    reservationId: UUID | None = None


class HeartbeatRequest(CommonMutation):
    reports: list[EntryReport]

    @model_validator(mode="after")
    def unique_entries(self) -> "HeartbeatRequest":
        ids = [report.entryId for report in self.reports]
        if len(ids) != len(set(ids)):
            raise ValueError("heartbeat reports must have unique entryId values")
        return self


class ReservationRequest(CommonMutation):
    sessionId: UUID
    entryId: str = Field(min_length=1)
    launchMode: Literal["read", "write", "unknown"]
    maxInstances: int | None = Field(default=None, ge=1)
    writeModeExclusive: bool


class LifecycleConflict(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message

    @property
    def detail(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


@dataclass
class StoredEntry:
    session_id: str
    station_id: str
    report: EntryReport
    lease_expires_at: float


@dataclass
class StoredReservation:
    reservation_id: str
    session_id: str
    station_id: str
    entry_id: str
    launch_mode: Literal["read", "write", "unknown"]
    expires_at: float


@dataclass
class StoredOperation:
    stored_at: float
    result: dict[str, object] | None = None
    conflict: dict[str, str] | None = None


class LifecycleStore:
    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.time,
        entry_lease_seconds: int = ENTRY_LEASE_SECONDS,
        reservation_lease_seconds: int = RESERVATION_LEASE_SECONDS,
    ) -> None:
        self._clock = clock
        self._entry_lease_seconds = entry_lease_seconds
        self._reservation_lease_seconds = reservation_lease_seconds
        self._entries: dict[tuple[str, str], StoredEntry] = {}
        self._reservations: dict[str, StoredReservation] = {}
        self._session_sequences: dict[str, int] = {}
        self._operations: dict[tuple[str, str], StoredOperation] = {}
        self._release_operations: dict[str, tuple[float, dict[str, object]]] = {}
        self._lock = asyncio.Lock()

    def _cleanup(self, now: float) -> None:
        self._entries = {
            key: entry
            for key, entry in self._entries.items()
            if entry.lease_expires_at > now
        }
        self._reservations = {
            key: reservation
            for key, reservation in self._reservations.items()
            if reservation.expires_at > now
        }
        self._operations = {
            key: operation
            for key, operation in self._operations.items()
            if operation.stored_at > now - OPERATION_CACHE_SECONDS
        }
        self._release_operations = {
            key: operation
            for key, operation in self._release_operations.items()
            if operation[0] > now - OPERATION_CACHE_SECONDS
        }

    def _operation_key(self, session_id: str, operation_id: UUID) -> tuple[str, str]:
        return session_id, str(operation_id)

    def _replay(self, session_id: str, operation_id: UUID) -> dict[str, object] | None:
        stored = self._operations.get(self._operation_key(session_id, operation_id))
        if stored is None:
            return None
        if stored.conflict is not None:
            raise LifecycleConflict(stored.conflict["code"], stored.conflict["message"])
        return dict(stored.result or {})

    def _remember_result(
        self, session_id: str, operation_id: UUID, result: dict[str, object]
    ) -> None:
        self._operations[self._operation_key(session_id, operation_id)] = StoredOperation(
            stored_at=self._clock(),
            result=dict(result)
        )

    def _remember_conflict(
        self, session_id: str, operation_id: UUID, conflict: LifecycleConflict
    ) -> None:
        self._operations[self._operation_key(session_id, operation_id)] = StoredOperation(
            stored_at=self._clock(),
            conflict=conflict.detail
        )

    def _accept_sequence(self, session_id: str, sequence: int) -> None:
        previous = self._session_sequences.get(session_id, 0)
        if sequence <= previous:
            raise LifecycleConflict(
                "stale-sequence",
                f"Sequence {sequence} is not newer than accepted sequence {previous} for this session.",
            )
        self._session_sequences[session_id] = sequence

    def _mutation_response(
        self, session_id: str, sequence: int, now: float, lease_expires_at: float
    ) -> dict[str, object]:
        return {
            "acceptedSequence": sequence,
            "serverTime": utc_iso(now),
            "leaseTtlSeconds": self._entry_lease_seconds,
            "leaseExpiresAt": utc_iso(lease_expires_at),
            "entryCount": sum(
                1 for entry in self._entries.values() if entry.session_id == session_id
            ),
        }

    async def register(
        self, session_id: str, entry_id: str, request: RegisterRequest
    ) -> dict[str, object]:
        async with self._lock:
            now = self._clock()
            self._cleanup(now)
            replay = self._replay(session_id, request.operationId)
            if replay is not None:
                return replay
            try:
                self._accept_sequence(session_id, request.sequence)
                if request.report.entryId != entry_id:
                    raise LifecycleConflict(
                        "entry-id-mismatch",
                        f"Path entryId '{entry_id}' does not match report entryId '{request.report.entryId}'.",
                    )
                if request.reservationId is not None:
                    reservation_id = str(request.reservationId)
                    reservation = self._reservations.get(reservation_id)
                    if reservation is None:
                        raise LifecycleConflict(
                            "reservation-missing",
                            "The launch reservation is absent or expired and cannot be committed.",
                        )
                    if reservation.session_id != session_id or reservation.entry_id != entry_id:
                        raise LifecycleConflict(
                            "reservation-owner-mismatch",
                            "The launch reservation belongs to a different session or entry.",
                        )
                    del self._reservations[reservation_id]
                lease_expires_at = now + self._entry_lease_seconds
                self._entries[(session_id, entry_id)] = StoredEntry(
                    session_id=session_id,
                    station_id=request.stationId,
                    report=request.report,
                    lease_expires_at=lease_expires_at,
                )
                result = self._mutation_response(
                    session_id, request.sequence, now, lease_expires_at
                )
                self._remember_result(session_id, request.operationId, result)
                return result
            except LifecycleConflict as conflict:
                self._remember_conflict(session_id, request.operationId, conflict)
                raise

    async def heartbeat(
        self, session_id: str, request: HeartbeatRequest
    ) -> dict[str, object]:
        async with self._lock:
            now = self._clock()
            self._cleanup(now)
            replay = self._replay(session_id, request.operationId)
            if replay is not None:
                return replay
            try:
                self._accept_sequence(session_id, request.sequence)
                for key in [key for key in self._entries if key[0] == session_id]:
                    del self._entries[key]
                lease_expires_at = now + self._entry_lease_seconds
                for report in request.reports:
                    self._entries[(session_id, report.entryId)] = StoredEntry(
                        session_id=session_id,
                        station_id=request.stationId,
                        report=report,
                        lease_expires_at=lease_expires_at,
                    )
                reported_ids = {report.entryId for report in request.reports}
                for reservation_id in [
                    reservation_id
                    for reservation_id, reservation in self._reservations.items()
                    if reservation.session_id == session_id
                    and reservation.entry_id in reported_ids
                ]:
                    del self._reservations[reservation_id]
                result = self._mutation_response(
                    session_id, request.sequence, now, lease_expires_at
                )
                self._remember_result(session_id, request.operationId, result)
                return result
            except LifecycleConflict as conflict:
                self._remember_conflict(session_id, request.operationId, conflict)
                raise

    async def deregister(
        self,
        session_id: str,
        entry_id: str,
        *,
        station_id: str,
        operation_id: UUID,
        sequence: int,
    ) -> dict[str, object]:
        async with self._lock:
            now = self._clock()
            self._cleanup(now)
            replay = self._replay(session_id, operation_id)
            if replay is not None:
                return replay
            try:
                self._accept_sequence(session_id, sequence)
                self._entries.pop((session_id, entry_id), None)
                lease_expires_at = now + self._entry_lease_seconds
                result = self._mutation_response(
                    session_id, sequence, now, lease_expires_at
                )
                self._remember_result(session_id, operation_id, result)
                return result
            except LifecycleConflict as conflict:
                self._remember_conflict(session_id, operation_id, conflict)
                raise

    async def query(
        self, entry_id: str | None, exclude_session_id: str | None
    ) -> dict[str, object]:
        async with self._lock:
            now = self._clock()
            self._cleanup(now)
            visible = [
                entry
                for entry in self._entries.values()
                if (entry_id is None or entry.report.entryId == entry_id)
                and (exclude_session_id is None or entry.session_id != exclude_session_id)
            ]
            visible.sort(key=lambda item: (item.report.entryId, item.session_id))
            return {
                "serverTime": utc_iso(now),
                "entries": [
                    {
                        "sessionId": entry.session_id,
                        "stationId": entry.station_id,
                        "report": entry.report.model_dump(mode="json"),
                        "leaseExpiresAt": utc_iso(entry.lease_expires_at),
                    }
                    for entry in visible
                ],
            }

    def _running_modes(self, entry_id: str) -> list[str]:
        modes: list[str] = []
        for stored in self._entries.values():
            if stored.report.entryId != entry_id or stored.report.runtime.status == "stopped":
                continue
            running = [
                instance
                for instance in stored.report.instances
                if instance.state == "running" or instance.state == "unknown"
            ]
            modes.extend(instance.launchMode for instance in running)
            if not running and stored.report.runtime.status != "stopped":
                modes.append("unknown")
        return modes

    async def reserve(self, request: ReservationRequest) -> dict[str, object]:
        session_id = str(request.sessionId)
        async with self._lock:
            now = self._clock()
            self._cleanup(now)
            replay = self._replay(session_id, request.operationId)
            if replay is not None:
                return replay
            try:
                self._accept_sequence(session_id, request.sequence)
                running_modes = self._running_modes(request.entryId)
                active_reservations = [
                    reservation
                    for reservation in self._reservations.values()
                    if reservation.entry_id == request.entryId
                ]
                if request.maxInstances is not None:
                    active_count = len(running_modes) + len(active_reservations)
                    if active_count >= request.maxInstances:
                        raise LifecycleConflict(
                            "instance-limit",
                            f"Entry '{request.entryId}' has {active_count} live instance or reservation; maxInstances is {request.maxInstances}.",
                        )
                if request.writeModeExclusive:
                    existing_modes = running_modes + [
                        reservation.launch_mode for reservation in active_reservations
                    ]
                    if request.launchMode == "unknown" and existing_modes:
                        raise LifecycleConflict(
                            "write-mode-unknown",
                            f"Entry '{request.entryId}' has live state, but the requested launch mode is unknown.",
                        )
                    if request.launchMode == "write" and any(
                        mode in ("write", "unknown") for mode in existing_modes
                    ):
                        raise LifecycleConflict(
                            "write-exclusive",
                            f"Entry '{request.entryId}' already has a write-mode or unknown-mode instance or reservation.",
                        )

                reservation_id = str(uuid4())
                expires_at = now + self._reservation_lease_seconds
                self._reservations[reservation_id] = StoredReservation(
                    reservation_id=reservation_id,
                    session_id=session_id,
                    station_id=request.stationId,
                    entry_id=request.entryId,
                    launch_mode=request.launchMode,
                    expires_at=expires_at,
                )
                result = {
                    "granted": True,
                    "reservationId": reservation_id,
                    "expiresAt": utc_iso(expires_at),
                    "serverTime": utc_iso(now),
                    "acceptedSequence": request.sequence,
                }
                self._remember_result(session_id, request.operationId, result)
                return result
            except LifecycleConflict as conflict:
                self._remember_conflict(session_id, request.operationId, conflict)
                raise

    async def release(self, reservation_id: str, operation_id: UUID) -> dict[str, object]:
        async with self._lock:
            operation_key = str(operation_id)
            replay = self._release_operations.get(operation_key)
            if replay is not None:
                return dict(replay[1])
            now = self._clock()
            self._cleanup(now)
            self._reservations.pop(reservation_id, None)
            result = {"released": True, "serverTime": utc_iso(now)}
            self._release_operations[operation_key] = (now, result)
            return result


def validate_bind(host: str, token: str | None) -> None:
    normalized = host.strip().strip("[]")
    loopback = normalized.lower() == "localhost"
    if not loopback:
        try:
            loopback = ipaddress.ip_address(normalized).is_loopback
        except ValueError:
            loopback = False
    if not loopback and not token:
        raise RuntimeError(
            "A non-loopback lifecycle bind requires ELI_HMI_LIFECYCLE_TOKEN."
        )


def create_app(
    *, store: LifecycleStore | None = None, token: str | None = None
) -> FastAPI:
    lifecycle = store or LifecycleStore()
    configured_token = token if token is not None else os.getenv("ELI_HMI_LIFECYCLE_TOKEN")
    app = FastAPI(
        title="Local HMI lifecycle contract",
        version="1",
        description=(
            "Loopback launcher-lifecycle acceptance service; not the ELI HMI EPICS gateway "
            "and not a site API contract."
        ),
    )

    async def require_token(
        authorization: Annotated[str | None, Header()] = None,
    ) -> None:
        if configured_token is None:
            return
        if authorization != f"Bearer {configured_token}":
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Missing or invalid lifecycle bearer token.",
                headers={"WWW-Authenticate": "Bearer"},
            )

    protected = [Depends(require_token)]

    def raise_http_conflict(conflict: LifecycleConflict) -> None:
        raise HTTPException(status_code=409, detail=conflict.detail) from conflict

    @app.get(f"{API_PREFIX}/health/live")
    async def health_live() -> dict[str, object]:
        return {
            "status": "ok",
            "contract": "local-launcher-lifecycle",
            "schemaVersion": SCHEMA_VERSION,
        }

    @app.put(
        f"{API_PREFIX}/sessions/{{session_id}}/entries/{{entry_id}}",
        dependencies=protected,
    )
    async def register_entry(
        session_id: UUID, entry_id: str, request: RegisterRequest
    ) -> dict[str, object]:
        try:
            return await lifecycle.register(str(session_id), entry_id, request)
        except LifecycleConflict as conflict:
            raise_http_conflict(conflict)

    @app.post(
        f"{API_PREFIX}/sessions/{{session_id}}/heartbeat", dependencies=protected
    )
    async def heartbeat(
        session_id: UUID, request: HeartbeatRequest
    ) -> dict[str, object]:
        try:
            return await lifecycle.heartbeat(str(session_id), request)
        except LifecycleConflict as conflict:
            raise_http_conflict(conflict)

    @app.delete(
        f"{API_PREFIX}/sessions/{{session_id}}/entries/{{entry_id}}",
        dependencies=protected,
    )
    async def deregister_entry(
        session_id: UUID,
        entry_id: str,
        stationId: Annotated[str, Query(min_length=1)],
        operationId: UUID,
        sequence: Annotated[int, Query(ge=1)],
        schemaVersion: Annotated[int, Query(ge=SCHEMA_VERSION, le=SCHEMA_VERSION)],
    ) -> dict[str, object]:
        try:
            return await lifecycle.deregister(
                str(session_id),
                entry_id,
                station_id=stationId,
                operation_id=operationId,
                sequence=sequence,
            )
        except LifecycleConflict as conflict:
            raise_http_conflict(conflict)

    @app.get(f"{API_PREFIX}/entries", dependencies=protected)
    async def query_entries(
        entryId: str | None = None, excludeSessionId: UUID | None = None
    ) -> dict[str, object]:
        return await lifecycle.query(
            entryId, str(excludeSessionId) if excludeSessionId is not None else None
        )

    @app.post(
        f"{API_PREFIX}/reservations",
        status_code=status.HTTP_201_CREATED,
        dependencies=protected,
    )
    async def acquire_reservation(request: ReservationRequest) -> dict[str, object]:
        try:
            return await lifecycle.reserve(request)
        except LifecycleConflict as conflict:
            raise_http_conflict(conflict)

    @app.delete(
        f"{API_PREFIX}/reservations/{{reservation_id}}", dependencies=protected
    )
    async def release_reservation(
        reservation_id: UUID, operationId: UUID
    ) -> dict[str, object]:
        return await lifecycle.release(str(reservation_id), operationId)

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    bind = os.getenv("ELI_HMI_LIFECYCLE_BIND", "127.0.0.1")
    configured_token = os.getenv("ELI_HMI_LIFECYCLE_TOKEN")
    validate_bind(bind, configured_token)
    port = int(os.getenv("ELI_HMI_LIFECYCLE_PORT", "8765"))
    uvicorn.run(app, host=bind, port=port, log_level="info")
