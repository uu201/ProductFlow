from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, cast

from dramatiq.middleware.time_limit import TimeLimitExceeded
from sqlalchemy import update
from sqlalchemy.engine import CursorResult
from sqlalchemy.orm import Session

from productflow_backend.application.admission import generation_running_capacity_available
from productflow_backend.application.product_workflow import graph as product_workflow_graph
from productflow_backend.application.time import now_utc
from productflow_backend.domain.durable_generation_tasks import WORKFLOW_RUN_GENERATION_TASK_CONTRACT
from productflow_backend.domain.enums import WorkflowNodeStatus, WorkflowRunStatus
from productflow_backend.infrastructure.db.models import WorkflowNode, WorkflowNodeRun, WorkflowRun
from productflow_backend.infrastructure.queue import enqueue_workflow_run_later

logger = logging.getLogger(__name__)

WORKFLOW_WORKER_TIMEOUT_FAILURE = "工作流执行超时，请稍后重试"
WORKFLOW_CANCELLED_REASON = "已取消"
PRODUCT_WORKFLOW_CAPACITY_RETRY_DELAY_MS = 2000


class WorkflowSafeExecutionError(RuntimeError):
    """Execution failure whose string is safe to persist and show to users."""

    def __init__(self, safe_message: str) -> None:
        super().__init__(safe_message)
        self.safe_message = safe_message


@dataclass(frozen=True, slots=True)
class WorkflowNodeRunClaimResult:
    claimed: bool
    should_requeue: bool = False


def safe_workflow_failure_reason(exc: BaseException) -> str:
    if isinstance(exc, TimeLimitExceeded):
        return WORKFLOW_WORKER_TIMEOUT_FAILURE
    if isinstance(exc, WorkflowSafeExecutionError):
        return exc.safe_message
    return str(exc)


def claim_workflow_node_run(session: Session, *, node_run_id: str, node_id: str) -> WorkflowNodeRunClaimResult:
    """Atomically claim one queued node run so duplicate Dramatiq messages do not execute it twice."""

    now = now_utc()
    if not generation_running_capacity_available(session):
        session.commit()
        return WorkflowNodeRunClaimResult(claimed=False, should_requeue=True)
    result = cast(
        CursorResult[Any],
        session.execute(
            update(WorkflowNodeRun)
            .where(
                WorkflowNodeRun.id == node_run_id,
                WorkflowNodeRun.status == WORKFLOW_RUN_GENERATION_TASK_CONTRACT.execution_queued_statuses[0],
            )
            .values(status=WORKFLOW_RUN_GENERATION_TASK_CONTRACT.execution_running_statuses[0], started_at=now)
        ),
    )
    if result.rowcount != 1:
        session.rollback()
        return WorkflowNodeRunClaimResult(claimed=False)
    session.execute(
        update(WorkflowNode)
        .where(WorkflowNode.id == node_id)
        .values(status=WorkflowNodeStatus.RUNNING, failure_reason=None, last_run_at=now)
    )
    session.commit()
    return WorkflowNodeRunClaimResult(claimed=True)


def requeue_workflow_run_after_capacity_wait(run_id: str) -> None:
    try:
        enqueue_workflow_run_later(run_id, delay_ms=PRODUCT_WORKFLOW_CAPACITY_RETRY_DELAY_MS)
    except Exception:  # noqa: BLE001
        logger.exception("商品工作流等待并发容量后重新入队失败: workflow_run_id=%s", run_id)


def mark_workflow_run_failed(
    session: Session,
    *,
    run_id: str,
    failed_node_id: str | None,
    reason: str,
) -> None:
    persisted_run = session.get(WorkflowRun, run_id)
    if persisted_run is None:
        return
    if WORKFLOW_RUN_GENERATION_TASK_CONTRACT.is_terminal(persisted_run.status):
        return
    now = now_utc()
    if failed_node_id is not None:
        failed_node = product_workflow_graph.get_node_or_raise(session, failed_node_id)
        failed_node.status = WorkflowNodeStatus.FAILED
        failed_node.failure_reason = reason
        failed_node.last_run_at = now
    for node_run in persisted_run.node_runs:
        if node_run.node_id == failed_node_id:
            node_run.status = WorkflowNodeStatus.FAILED
            node_run.failure_reason = reason
            node_run.finished_at = now
        elif failed_node_id is None and WORKFLOW_RUN_GENERATION_TASK_CONTRACT.execution_is_running(node_run.status):
            failed_node = session.get(WorkflowNode, node_run.node_id)
            if failed_node is not None:
                failed_node.status = WorkflowNodeStatus.FAILED
                failed_node.failure_reason = reason
                failed_node.last_run_at = now
            node_run.status = WorkflowNodeStatus.FAILED
            node_run.failure_reason = reason
            node_run.finished_at = now
        elif WORKFLOW_RUN_GENERATION_TASK_CONTRACT.execution_is_queued(node_run.status):
            skipped_node = session.get(WorkflowNode, node_run.node_id)
            if skipped_node is not None:
                skipped_node.status = WorkflowNodeStatus.IDLE
                skipped_node.failure_reason = None
            node_run.status = WorkflowNodeStatus.FAILED
            node_run.failure_reason = "上游节点失败"
            node_run.finished_at = now
    logger.warning("工作流运行失败: run_id=%s failed_node_id=%s reason=%s", run_id, failed_node_id, reason)
    persisted_run.status = WorkflowRunStatus.FAILED
    persisted_run.failure_reason = reason
    persisted_run.finished_at = now
    persisted_run.workflow.updated_at = now
    session.commit()


def mark_workflow_run_cancelled(session: Session, *, run_id: str) -> None:
    persisted_run = session.get(WorkflowRun, run_id)
    if persisted_run is None:
        return
    if WORKFLOW_RUN_GENERATION_TASK_CONTRACT.is_terminal(persisted_run.status):
        return
    now = now_utc()
    for node_run in persisted_run.node_runs:
        if WORKFLOW_RUN_GENERATION_TASK_CONTRACT.execution_is_queued(node_run.status):
            skipped_node = session.get(WorkflowNode, node_run.node_id)
            if skipped_node is not None:
                skipped_node.status = WorkflowNodeStatus.IDLE
                skipped_node.failure_reason = None
            node_run.status = WorkflowNodeStatus.FAILED
            node_run.failure_reason = WORKFLOW_CANCELLED_REASON
            node_run.finished_at = now
        elif WORKFLOW_RUN_GENERATION_TASK_CONTRACT.execution_is_running(node_run.status):
            running_node = session.get(WorkflowNode, node_run.node_id)
            if running_node is not None:
                running_node.status = WorkflowNodeStatus.FAILED
                running_node.failure_reason = WORKFLOW_CANCELLED_REASON
                running_node.last_run_at = now
            node_run.status = WorkflowNodeStatus.FAILED
            node_run.failure_reason = WORKFLOW_CANCELLED_REASON
            node_run.finished_at = now
    persisted_run.status = WorkflowRunStatus.CANCELLED
    persisted_run.failure_reason = WORKFLOW_CANCELLED_REASON
    persisted_run.finished_at = now
    persisted_run.workflow.updated_at = now
    session.commit()
