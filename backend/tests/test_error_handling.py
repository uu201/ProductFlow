from __future__ import annotations

import pytest
from fastapi import HTTPException
from helpers import _make_demo_image_bytes

from productflow_backend.application.image_sessions import create_image_session, submit_image_session_generation_task
from productflow_backend.application.product_workflow import graph as product_workflow_graph
from productflow_backend.application.product_workflow.context import poster_kind_from_config
from productflow_backend.application.product_workflow.mutations import (
    create_workflow_edge,
    create_workflow_node,
    get_or_create_product_workflow,
)
from productflow_backend.application.use_cases import create_product
from productflow_backend.domain.enums import WorkflowNodeType
from productflow_backend.domain.errors import BusinessError, BusinessValidationError, NotFoundError
from productflow_backend.presentation.errors import raise_value_error_as_http


def _mapped_http_error(exc: ValueError) -> HTTPException:
    with pytest.raises(HTTPException) as raised:
        raise_value_error_as_http(exc)
    return raised.value


def test_typed_not_found_maps_to_404_without_message_suffix() -> None:
    error = _mapped_http_error(NotFoundError("资源已移除"))

    assert error.status_code == 404
    assert error.detail == "资源已移除"


def test_typed_business_error_maps_to_400() -> None:
    error = _mapped_http_error(BusinessError("请选择一张图片"))

    assert error.status_code == 400
    assert error.detail == "请选择一张图片"


def test_typed_poster_file_missing_remains_400() -> None:
    error = _mapped_http_error(BusinessValidationError("海报文件不存在"))

    assert error.status_code == 400
    assert error.detail == "海报文件不存在"


def test_typed_workflow_integrity_error_remains_400() -> None:
    error = _mapped_http_error(BusinessValidationError("工作流连线引用了不存在的节点"))

    assert error.status_code == 400
    assert error.detail == "工作流连线引用了不存在的节点"


def test_legacy_value_error_fallback_remains_compatible() -> None:
    missing = _mapped_http_error(ValueError("旧资源不存在"))
    poster_file_missing = _mapped_http_error(ValueError("海报文件不存在"))
    generic = _mapped_http_error(ValueError("普通业务错误"))

    assert missing.status_code == 404
    assert missing.detail == "旧资源不存在"
    assert poster_file_missing.status_code == 400
    assert poster_file_missing.detail == "海报文件不存在"
    assert generic.status_code == 400
    assert generic.detail == "普通业务错误"


def test_high_risk_business_paths_raise_typed_validation_errors(db_session, configured_env) -> None:  # noqa: ARG001
    with pytest.raises(BusinessValidationError, match="商品名不能为空"):
        create_product(
            db_session,
            name="   ",
            category=None,
            price=None,
            source_note=None,
            image_bytes=_make_demo_image_bytes(),
            filename="blank.png",
            content_type="image/png",
        )
    db_session.rollback()

    with pytest.raises(BusinessValidationError, match="价格格式不正确"):
        create_product(
            db_session,
            name="价格格式错误商品",
            category=None,
            price="abc",
            source_note=None,
            image_bytes=_make_demo_image_bytes(),
            filename="invalid-price.png",
            content_type="image/png",
        )
    db_session.rollback()

    product = create_product(
        db_session,
        name="typed error 商品",
        category=None,
        price=None,
        source_note=None,
        image_bytes=_make_demo_image_bytes(),
        filename="typed.png",
        content_type="image/png",
    )
    with pytest.raises(BusinessValidationError, match="商品资料节点已存在"):
        create_workflow_node(
            db_session,
            product_id=product.id,
            node_type=WorkflowNodeType.PRODUCT_CONTEXT,
            title="重复商品资料",
            position_x=0,
            position_y=0,
            config_json={},
        )

    workflow = get_or_create_product_workflow(db_session, product.id)
    copy_node = next(node for node in workflow.nodes if node.node_type == WorkflowNodeType.COPY_GENERATION)
    image_node = next(node for node in workflow.nodes if node.node_type == WorkflowNodeType.IMAGE_GENERATION)
    with pytest.raises(BusinessValidationError, match="工作流不能包含循环依赖"):
        create_workflow_edge(
            db_session,
            product_id=product.id,
            source_node_id=image_node.id,
            target_node_id=copy_node.id,
        )
    db_session.rollback()

    image_session = create_image_session(db_session, product_id=None, title="typed error 生图")
    with pytest.raises(BusinessValidationError, match="一次生成数量必须在 1-4 张之间"):
        submit_image_session_generation_task(
            db_session,
            image_session_id=image_session.id,
            prompt="数量越界",
            size="1024x1024",
            generation_count=5,
        )

    with pytest.raises(BusinessValidationError, match="生图节点包含不支持的图片类型"):
        poster_kind_from_config({"poster_kind": "invalid"})


def test_workflow_edge_rollback_preserves_typed_business_errors(
    db_session,
    configured_env,  # noqa: ARG001
    monkeypatch,
) -> None:
    product = create_product(
        db_session,
        name="typed edge error 商品",
        category=None,
        price=None,
        source_note=None,
        image_bytes=_make_demo_image_bytes(),
        filename="typed-edge.png",
        content_type="image/png",
    )
    workflow = get_or_create_product_workflow(db_session, product.id)
    copy_node = next(node for node in workflow.nodes if node.node_type == WorkflowNodeType.COPY_GENERATION)
    reference_node = next(node for node in workflow.nodes if node.node_type == WorkflowNodeType.REFERENCE_IMAGE)

    def raise_not_found(_workflow):
        raise NotFoundError("工作流不存在")

    monkeypatch.setattr(product_workflow_graph, "topological_nodes", raise_not_found)

    with pytest.raises(NotFoundError, match="工作流不存在"):
        create_workflow_edge(
            db_session,
            product_id=product.id,
            source_node_id=copy_node.id,
            target_node_id=reference_node.id,
        )
