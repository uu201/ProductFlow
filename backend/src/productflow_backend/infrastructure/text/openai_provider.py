from __future__ import annotations

import json
from json import JSONDecodeError

from openai import OpenAI

from productflow_backend.application.contracts import (
    CopyNodeConfigV2,
    CopyPayloadV2,
    CreativeBriefPayload,
    ProductInput,
    ReferenceImageInput,
)
from productflow_backend.application.copy_payloads import normalize_copy_payload
from productflow_backend.config import get_runtime_settings
from productflow_backend.infrastructure.prompts import text_or_default
from productflow_backend.infrastructure.text.base import TextProvider


class OpenAITextProvider(TextProvider):
    provider_name = "openai"
    prompt_version = "responses-json-v1"

    def __init__(self) -> None:
        settings = get_runtime_settings()
        client_kwargs = {"api_key": settings.text_api_key}
        if settings.text_base_url:
            client_kwargs["base_url"] = settings.text_base_url
        self.client = OpenAI(**client_kwargs)
        self.brief_model = settings.text_brief_model
        self.copy_model = settings.text_copy_model
        self.brief_system_prompt = settings.prompt_brief_system
        self.copy_system_prompt = settings.prompt_copy_system

    def _read_output_json(self, response) -> dict:
        text = _response_output_text(response)
        if text.startswith("```"):
            lines = text.splitlines()
            if lines and lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].startswith("```"):
                lines = lines[:-1]
            text = "\n".join(lines).strip()
        try:
            return json.loads(text)
        except JSONDecodeError as exc:
            extracted = _extract_json_object_text(text)
            if extracted:
                return json.loads(extracted)
            snippet = text[:200] if text else "<empty>"
            raise ValueError(f"文案 provider 未返回 JSON 对象：{snippet}") from exc

    def generate_brief(self, product: ProductInput) -> tuple[CreativeBriefPayload, str]:
        response = self.client.responses.create(
            model=self.brief_model,
            instructions=text_or_default(self.brief_system_prompt, "请输出简洁、结构化的中文 JSON。"),
            input=[
                {
                    "role": "user",
                    "content": (
                        f"商品名：{product.name}\n"
                        f"类目：{product.category or '未提供'}\n"
                        f"价格：{product.price or '未提供'}\n"
                        f"商品描述/补充说明：{product.source_note or '未提供'}\n"
                        "请输出字段：positioning、audience、selling_angles(3到5条)、"
                        "taboo_phrases、poster_style_hint。"
                    ),
                },
            ],
        )
        payload = CreativeBriefPayload.model_validate(self._read_output_json(response))
        return payload, self.brief_model

    def generate_copy(
        self,
        product: ProductInput,
        brief: CreativeBriefPayload,
        config: CopyNodeConfigV2 | None = None,
        reference_images: list[ReferenceImageInput] | None = None,
    ) -> tuple[CopyPayloadV2, str]:
        config = config or CopyNodeConfigV2()
        reference_images = reference_images or []
        reference_lines = [
            (
                f"{index}. {reference.label or reference.filename}"
                f"（角色：{reference.role or '参考图'}，类型：{reference.mime_type}，文件：{reference.filename}）"
            )
            for index, reference in enumerate(reference_images, start=1)
        ]
        reference_text = "\n".join(reference_lines) if reference_lines else "未连接"
        response = self.client.responses.create(
            model=self.copy_model,
            instructions=text_or_default(self.copy_system_prompt, "请输出中文 JSON，不要输出 markdown。"),
            input=[
                {
                    "role": "user",
                    "content": (
                        f"商品名：{product.name}\n"
                        f"类目：{product.category or '未提供'}\n"
                        f"价格：{product.price or '未提供'}\n"
                        f"商品描述/补充说明：{product.source_note or '未提供'}\n"
                        f"参考图：{reference_text}\n"
                        f"文案用途：{config.purpose or '未指定'}\n"
                        f"输出模式：{config.output_mode}\n"
                        f"渠道：{config.channel or '未指定'}\n"
                        f"语气：{config.tone or '未指定'}\n"
                        f"本轮文案要求：{config.instruction or '按商品和场景自由组织文案'}\n"
                        f"可选槽位：{[slot.model_dump(mode='json') for slot in config.requested_slots]}\n"
                        f"商品定位：{brief.positioning}\n"
                        f"目标人群：{brief.audience}\n"
                        f"卖点角度：{', '.join(brief.selling_angles)}\n"
                        f"禁忌表达：{', '.join(brief.taboo_phrases) or '无'}\n"
                        "请输出 v2 JSON 外壳：version=2、purpose、summary、content、visual_guidance。\n"
                        "content.kind 必须是 freeform、blocks 或 layout_brief。"
                        "不要为了满足固定字段编造 CTA、海报标题或固定 3 到 5 条卖点。"
                    ),
                },
            ],
        )
        payload = normalize_copy_payload(self._read_output_json(response), fallback_purpose=config.purpose)
        return payload, self.copy_model


def _extract_json_object_text(text: str) -> str | None:
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escaped = False
    for index, character in enumerate(text[start:], start=start):
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
        elif character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    return None


def _response_output_text(response: object) -> str:
    if isinstance(response, str):
        return (_extract_sse_output_text(response) or response).strip()

    output_text = getattr(response, "output_text", "")
    if isinstance(output_text, str) and output_text.strip():
        return output_text.strip()

    model_dump = getattr(response, "model_dump", None)
    if callable(model_dump):
        try:
            payload = model_dump(mode="json")
        except TypeError:
            payload = model_dump()
        if isinstance(payload, dict):
            return _extract_response_dict_text(payload).strip()

    return ""


def _extract_sse_output_text(text: str) -> str | None:
    current_event: str | None = None
    chunks: list[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("event:"):
            current_event = line.split(":", 1)[1].strip()
            continue
        if not line.startswith("data:"):
            continue
        data_text = line.split(":", 1)[1].strip()
        if not data_text or data_text == "[DONE]":
            continue
        try:
            payload = json.loads(data_text)
        except JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        delta = payload.get("delta")
        is_output_text_delta = (
            current_event == "response.output_text.delta" or payload.get("type") == "response.output_text.delta"
        )
        if is_output_text_delta and isinstance(delta, str):
            chunks.append(delta)

    if chunks:
        return "".join(chunks)
    return None


def _extract_response_dict_text(payload: dict) -> str:
    output = payload.get("output")
    if not isinstance(output, list):
        return ""
    chunks: list[str] = []
    for item in output:
        if not isinstance(item, dict):
            continue
        content = item.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            text = block.get("text")
            if isinstance(text, str):
                chunks.append(text)
    return "".join(chunks)
