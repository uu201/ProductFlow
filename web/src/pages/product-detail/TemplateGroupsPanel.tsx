import {
  ChevronDown,
  ChevronRight,
  FileText,
  ImageIcon,
  ImagePlus,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { CanvasTemplateSummary } from "../../lib/types";
import { NODE_LABELS } from "./constants";

const PREVIEW_VIEWBOX_WIDTH = 420;
const PREVIEW_VIEWBOX_HEIGHT = 214;
const PREVIEW_PADDING_X = 22;
const PREVIEW_PADDING_Y = 22;
const PREVIEW_NODE_WIDTH = 76;
const PREVIEW_NODE_HEIGHT = 50;

const TEMPLATE_CATEGORY_ORDER = [
  { key: "all", label: "全部" },
  { key: "listing", label: "平台首图" },
  { key: "detail", label: "详情说服" },
  { key: "gallery", label: "场景图册" },
  { key: "content", label: "内容种草" },
  { key: "campaign", label: "活动投放" },
  { key: "custom", label: "自定义" },
] as const;

type TemplateCategoryKey = (typeof TEMPLATE_CATEGORY_ORDER)[number]["key"];

interface TemplateGroupsPanelProps {
  templates: CanvasTemplateSummary[];
  isLoading: boolean;
  isError: boolean;
  structureBusy: boolean;
  applyBusy: boolean;
  applyingTemplateKey: string | null;
  onApplyTemplate: (template: CanvasTemplateSummary) => void;
  userTemplateBusy: boolean;
  onRenameUserTemplate: (template: CanvasTemplateSummary, title: string) => void;
  onArchiveUserTemplate: (template: CanvasTemplateSummary) => void;
}

function summarizeOutput(template: CanvasTemplateSummary): string {
  const labels = template.output_slots.map((slot) => slot.label).filter(Boolean);
  if (!labels.length) {
    return "输出槽";
  }
  return labels[0];
}

function summarizeReferenceInput(template: CanvasTemplateSummary): string | null {
  const requiredHints = template.reference_input_hints.filter((hint) => hint.required);
  const hints = requiredHints.length ? requiredHints : template.reference_input_hints;
  const labels = hints.map((hint) => hint.label).filter(Boolean);
  if (!labels.length) {
    return null;
  }
  return labels[0];
}

function externalConnectionLabels(template: CanvasTemplateSummary): string[] {
  return Array.from(new Set(template.default_external_connections.map((connection) => connection.label).filter(Boolean)));
}

function templateCategoryKey(template: CanvasTemplateSummary): TemplateCategoryKey {
  if (template.source === "user") {
    return "custom";
  }
  const stage = template.scenario.ecommerce_stage;
  if (
    stage === "listing"
    || stage === "detail"
    || stage === "gallery"
    || stage === "content"
    || stage === "campaign"
  ) {
    return stage;
  }
  return "detail";
}

function templateCategoryCounts(templates: CanvasTemplateSummary[]): Record<TemplateCategoryKey, number> {
  const counts = Object.fromEntries(TEMPLATE_CATEGORY_ORDER.map((category) => [category.key, 0])) as Record<
    TemplateCategoryKey,
    number
  >;
  counts.all = templates.length;
  for (const template of templates) {
    counts[templateCategoryKey(template)] += 1;
  }
  return counts;
}

type PreviewNode = CanvasTemplateSummary["preview_nodes"][number] & {
  x: number;
  y: number;
  centerX: number;
  centerY: number;
};

interface TemplatePreviewLayout {
  nodes: PreviewNode[];
  nodesByKey: Map<string, PreviewNode>;
}

function buildTemplatePreviewLayout(template: CanvasTemplateSummary): TemplatePreviewLayout | null {
  const nodes = template.preview_nodes;
  if (!nodes.length) {
    return null;
  }

  // 小卡片预览只保留列关系，不按真实画布宽度缩放，避免多列模板被压扁。
  const sortedUniqueX = Array.from(new Set(nodes.map((node) => node.position_x))).sort((a, b) => a - b);
  const minY = Math.min(...nodes.map((node) => node.position_y));
  const maxY = Math.max(...nodes.map((node) => node.position_y));
  const availableWidth = PREVIEW_VIEWBOX_WIDTH - PREVIEW_PADDING_X * 2 - PREVIEW_NODE_WIDTH;
  const availableHeight = PREVIEW_VIEWBOX_HEIGHT - PREVIEW_PADDING_Y * 2 - PREVIEW_NODE_HEIGHT;
  const columnGap = sortedUniqueX.length <= 1 ? 0 : availableWidth / (sortedUniqueX.length - 1);

  const layoutNodes = nodes.map((node) => {
    const columnIndex = sortedUniqueX.indexOf(node.position_x);
    const yRatio = minY === maxY ? 0.5 : (node.position_y - minY) / (maxY - minY);
    const x = sortedUniqueX.length <= 1
      ? (PREVIEW_VIEWBOX_WIDTH - PREVIEW_NODE_WIDTH) / 2
      : PREVIEW_PADDING_X + columnIndex * columnGap;
    const y = minY === maxY
      ? (PREVIEW_VIEWBOX_HEIGHT - PREVIEW_NODE_HEIGHT) / 2
      : PREVIEW_PADDING_Y + yRatio * availableHeight;
    return {
      ...node,
      x,
      y,
      centerX: x + PREVIEW_NODE_WIDTH / 2,
      centerY: y + PREVIEW_NODE_HEIGHT / 2,
    };
  });
  return {
    nodes: layoutNodes,
    nodesByKey: new Map(layoutNodes.map((node) => [node.key, node])),
  };
}

function truncatePreviewTitle(title: string, maxLength = 7): string {
  const trimmed = title.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength - 1).trimEnd()}...`;
}

function previewNodeMeta(nodeType: CanvasTemplateSummary["preview_nodes"][number]["node_type"]) {
  const iconByType: Record<CanvasTemplateSummary["preview_nodes"][number]["node_type"], LucideIcon> = {
    product_context: FileText,
    reference_image: ImagePlus,
    copy_generation: FileText,
    image_generation: ImageIcon,
  };
  const statusByType: Record<CanvasTemplateSummary["preview_nodes"][number]["node_type"], string> = {
    product_context: "可用",
    reference_image: "可用",
    copy_generation: "未运行",
    image_generation: "未运行",
  };
  if (nodeType === "copy_generation") {
    return { icon: iconByType[nodeType], label: NODE_LABELS[nodeType], status: statusByType[nodeType] };
  }
  if (nodeType === "image_generation") {
    return { icon: iconByType[nodeType], label: NODE_LABELS[nodeType], status: statusByType[nodeType] };
  }
  if (nodeType === "product_context") {
    return { icon: iconByType[nodeType], label: NODE_LABELS[nodeType], status: statusByType[nodeType] };
  }
  return { icon: iconByType[nodeType], label: NODE_LABELS[nodeType], status: statusByType[nodeType] };
}

function edgePath(source: PreviewNode, target: PreviewNode): string {
  const sourceX = target.centerX >= source.centerX ? source.x + PREVIEW_NODE_WIDTH : source.x;
  const targetX = target.centerX >= source.centerX ? target.x : target.x + PREVIEW_NODE_WIDTH;
  const controlOffset = Math.max(20, Math.abs(targetX - sourceX) * 0.45);
  const sourceControlX = sourceX + (target.centerX >= source.centerX ? controlOffset : -controlOffset);
  const targetControlX = targetX - (target.centerX >= source.centerX ? controlOffset : -controlOffset);
  return `M ${sourceX} ${source.centerY} C ${sourceControlX} ${source.centerY}, ${targetControlX} ${target.centerY}, ${targetX} ${target.centerY}`;
}

function TemplateGraphPreview({ template }: { template: CanvasTemplateSummary }) {
  const layout = buildTemplatePreviewLayout(template);
  if (layout === null) {
    return (
      <div className="flex h-36 items-center justify-center border-b border-dashed border-zinc-200 bg-zinc-50 text-[11px] text-zinc-400">
        暂无预览数据
      </div>
    );
  }

  const templateId = template.key.replace(/[^a-zA-Z0-9_-]/g, "-");
  const arrowId = `template-preview-arrow-${templateId}`;
  const gridId = `template-preview-grid-${templateId}`;
  const edges = template.preview_edges
    .map((edge) => ({
      edge,
      source: layout.nodesByKey.get(edge.source_node_key),
      target: layout.nodesByKey.get(edge.target_node_key),
    }))
    .filter(
      (item): item is {
        edge: CanvasTemplateSummary["preview_edges"][number];
        source: PreviewNode;
        target: PreviewNode;
      } => Boolean(item.source && item.target),
    );

  return (
    <div
      role="img"
      aria-label={`${template.title}模板结构预览`}
      className="relative h-52 overflow-hidden border-b border-zinc-100 bg-zinc-50"
    >
      <svg
        aria-hidden="true"
        className="absolute inset-0 h-full w-full"
        viewBox={`0 0 ${PREVIEW_VIEWBOX_WIDTH} ${PREVIEW_VIEWBOX_HEIGHT}`}
        preserveAspectRatio="none"
      >
        <defs>
          <pattern id={gridId} width="14" height="14" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.7" fill="#d4d4d8" />
          </pattern>
          <marker
            id={arrowId}
            markerHeight="6"
            markerUnits="strokeWidth"
            markerWidth="6"
            orient="auto"
            refX="5"
            refY="3"
          >
            <path d="M 0 0 L 6 3 L 0 6 z" fill="#6366f1" />
          </marker>
        </defs>
        <rect width={PREVIEW_VIEWBOX_WIDTH} height={PREVIEW_VIEWBOX_HEIGHT} fill="#fafafa" />
        <rect width={PREVIEW_VIEWBOX_WIDTH} height={PREVIEW_VIEWBOX_HEIGHT} fill={`url(#${gridId})`} opacity="0.85" />
        {edges.map(({ edge, source, target }) => (
          <path
            key={`${edge.source_node_key}->${edge.target_node_key}`}
            d={edgePath(source, target)}
            fill="none"
            markerEnd={`url(#${arrowId})`}
            stroke="#6366f1"
            strokeLinecap="round"
            strokeOpacity="0.72"
            strokeWidth="1.9"
          />
        ))}
      </svg>
      {layout.nodes.map((node) => {
        const meta = previewNodeMeta(node.node_type);
        const Icon = meta.icon;
        return (
          <div
            key={node.key}
            aria-label={`${node.title} ${meta.label}`}
            className="absolute rounded-lg border border-slate-200 bg-white/95 p-1.5 text-left shadow-sm backdrop-blur"
            style={{
              left: `${(node.x / PREVIEW_VIEWBOX_WIDTH) * 100}%`,
              top: `${(node.y / PREVIEW_VIEWBOX_HEIGHT) * 100}%`,
              width: `${(PREVIEW_NODE_WIDTH / PREVIEW_VIEWBOX_WIDTH) * 100}%`,
              height: `${(PREVIEW_NODE_HEIGHT / PREVIEW_VIEWBOX_HEIGHT) * 100}%`,
            }}
          >
            <span className="absolute left-[-4px] top-1/2 h-2 w-2 -translate-y-1/2 rounded-full border border-slate-300 bg-white shadow-sm" />
            <span className="absolute right-[-5px] top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full border-2 border-indigo-500 bg-white shadow-sm" />
            <div className="flex items-start gap-1.5">
              <div className="flex min-w-0 flex-1 gap-1.5">
                <span className="mt-0.5 rounded-md border border-slate-200 bg-slate-50 p-0.5 text-slate-500">
                  <Icon size={11} strokeWidth={2} />
                </span>
                <div className="min-w-0">
                  <div className="truncate text-[10px] font-semibold leading-3 text-zinc-900">
                    {truncatePreviewTitle(node.title)}
                  </div>
                  <div className="mt-0.5 text-[7px] font-medium uppercase leading-none text-zinc-400">
                    {meta.label}
                  </div>
                </div>
              </div>
            </div>
            <span className="mt-1 inline-flex rounded-full border border-zinc-200 bg-white px-1 py-0 text-[7px] font-medium leading-3 text-zinc-500">
              {meta.status}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function TemplateGroupsPanel({
  templates,
  isLoading,
  isError,
  structureBusy,
  applyBusy,
  applyingTemplateKey,
  onApplyTemplate,
  userTemplateBusy,
  onRenameUserTemplate,
  onArchiveUserTemplate,
}: TemplateGroupsPanelProps) {
  const [editingTemplateKey, setEditingTemplateKey] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [activeCategory, setActiveCategory] = useState<TemplateCategoryKey>("all");
  const [expandedTemplateKey, setExpandedTemplateKey] = useState<string | null>(templates[0]?.key ?? null);

  useEffect(() => {
    if (!templates.length) {
      setExpandedTemplateKey(null);
      return;
    }
    const expandedTemplateStillVisible = templates.some(
      (template) =>
        template.key === expandedTemplateKey
        && (activeCategory === "all" || templateCategoryKey(template) === activeCategory),
    );
    if (!expandedTemplateStillVisible) {
      const nextTemplate = templates.find(
        (template) => activeCategory === "all" || templateCategoryKey(template) === activeCategory,
      );
      setExpandedTemplateKey(nextTemplate?.key ?? null);
    }
  }, [activeCategory, expandedTemplateKey, templates]);

  if (isLoading) {
    return (
      <div className="flex min-h-[180px] items-center justify-center text-zinc-400">
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
        模板加载失败
      </div>
    );
  }

  if (!templates.length) {
    return (
      <div className="flex min-h-[160px] items-center justify-center rounded-xl border border-dashed border-zinc-200 bg-zinc-50/60 px-3 py-6 text-center text-xs text-zinc-500">
        暂无模板
      </div>
    );
  }

  const categoryCounts = templateCategoryCounts(templates);
  const visibleTemplates = templates.filter(
    (template) => activeCategory === "all" || templateCategoryKey(template) === activeCategory,
  );

  return (
    <section className="space-y-3">
      <div className="flex gap-1 overflow-x-auto border-b border-zinc-100 pb-2">
        {TEMPLATE_CATEGORY_ORDER.filter((category) => category.key === "all" || categoryCounts[category.key] > 0).map(
          (category) => {
            const active = activeCategory === category.key;
            return (
              <button
                key={category.key}
                type="button"
                onClick={() => {
                  setActiveCategory(category.key);
                  const nextTemplate = templates.find(
                    (template) => category.key === "all" || templateCategoryKey(template) === category.key,
                  );
                  setExpandedTemplateKey(nextTemplate?.key ?? null);
                }}
                className={`shrink-0 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
                  active
                    ? "border-zinc-950 bg-zinc-950 text-white"
                    : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50"
                }`}
              >
                {category.label}
                <span className={active ? "ml-1 text-zinc-300" : "ml-1 text-zinc-400"}>
                  {categoryCounts[category.key]}
                </span>
              </button>
            );
          },
        )}
      </div>

      {visibleTemplates.length ? null : (
        <div className="flex min-h-[120px] items-center justify-center rounded-lg border border-dashed border-zinc-200 bg-zinc-50/60 px-3 py-6 text-center text-xs text-zinc-500">
          当前分类暂无模板
        </div>
      )}

      <div className="space-y-2">
      {visibleTemplates.map((template) => {
        const templateBusy = applyBusy && applyingTemplateKey === template.key;
        const referenceLabel = summarizeReferenceInput(template);
        const externalLabels = externalConnectionLabels(template);
        const isUserTemplate = template.source === "user" && Boolean(template.user_template_id);
        const editing = editingTemplateKey === template.key;
        const expanded = expandedTemplateKey === template.key;
        return (
          <article
            key={template.key}
            className="group overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm transition-colors hover:border-zinc-300"
          >
            <div className="flex items-center gap-2 px-2.5 py-2">
              <button
                type="button"
                onClick={() => setExpandedTemplateKey(expanded ? null : template.key)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-50 hover:text-zinc-900"
                aria-label={expanded ? "收起模板预览" : "展开模板预览"}
                title={expanded ? "收起模板预览" : "展开模板预览"}
              >
                {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              </button>
              <div className="min-w-0 flex-1 space-y-1.5 text-left">
                <div className="min-w-0">
                  <h3 className="break-words text-sm font-semibold leading-5 text-zinc-950">
                    {template.title}
                  </h3>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-1">
                  {isUserTemplate ? (
                    <span className="rounded-sm border border-zinc-100 bg-zinc-50/70 px-1.5 py-0.5 text-[9px] font-medium text-zinc-400">
                      自定义
                    </span>
                  ) : null}
                  <span className="max-w-full truncate rounded-sm border border-emerald-100 bg-emerald-50/60 px-1.5 py-0.5 text-[9px] font-medium text-emerald-600">
                    {summarizeOutput(template)}
                  </span>
                  {referenceLabel ? (
                    <span className="max-w-full truncate rounded-sm border border-zinc-100 bg-white px-1.5 py-0.5 text-[9px] font-medium text-zinc-400">
                      {referenceLabel}
                    </span>
                  ) : null}
                  {externalLabels.map((label) => (
                    <span
                      key={label}
                      className="max-w-full truncate rounded-sm border border-indigo-100 bg-indigo-50/60 px-1.5 py-0.5 text-[9px] font-medium text-indigo-500"
                    >
                      {label}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {isUserTemplate ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingTemplateKey(template.key);
                        setEditingTitle(template.title);
                      }}
                      disabled={userTemplateBusy}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-500 transition-colors hover:bg-zinc-50 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label="重命名模板"
                      title="重命名模板"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onArchiveUserTemplate(template)}
                      disabled={userTemplateBusy}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-red-200 bg-red-50 text-red-600 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label="删除模板"
                      title="删除模板"
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  onClick={() => onApplyTemplate(template)}
                  disabled={structureBusy || applyBusy}
                  className="inline-flex h-8 items-center rounded-md bg-zinc-950 px-2.5 text-xs font-medium text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {templateBusy ? (
                    <Loader2 size={13} className="mr-1.5 animate-spin" />
                  ) : (
                    <Plus size={13} className="mr-1.5" />
                  )}
                  添加
                </button>
              </div>
            </div>
            {expanded ? (
              <div className="border-t border-zinc-100">
                <TemplateGraphPreview template={template} />
              </div>
            ) : null}
            {editing ? (
              <form
                className="flex items-center gap-2 border-t border-zinc-100 px-3 py-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const title = editingTitle.trim();
                  if (!title) {
                    return;
                  }
                  onRenameUserTemplate(template, title);
                  setEditingTemplateKey(null);
                }}
              >
                <input
                  value={editingTitle}
                  onChange={(event) => setEditingTitle(event.target.value)}
                  className="h-8 min-w-0 flex-1 rounded-md border border-zinc-200 px-2 text-xs text-zinc-900 outline-none focus:border-indigo-300"
                  maxLength={255}
                />
                <button
                  type="button"
                  onClick={() => setEditingTemplateKey(null)}
                  className="h-8 rounded-md px-2 text-xs font-medium text-zinc-500 hover:bg-zinc-50"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={userTemplateBusy || !editingTitle.trim()}
                  className="h-8 rounded-md bg-zinc-950 px-2.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  保存
                </button>
              </form>
            ) : null}
          </article>
        );
      })}
      </div>
    </section>
  );
}
