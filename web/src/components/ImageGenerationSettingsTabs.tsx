import type { ReactNode } from "react";

export type ImageGenerationSettingsTab = "basic" | "advanced";

interface ImageGenerationSettingsTabsProps {
  value: ImageGenerationSettingsTab;
  onChange: (value: ImageGenerationSettingsTab) => void;
  basic: ReactNode;
  advanced: ReactNode;
  className?: string;
}

export function ImageGenerationSettingsTabs({
  value,
  onChange,
  basic,
  advanced,
  className = "",
}: ImageGenerationSettingsTabsProps) {
  const tabs: readonly [ImageGenerationSettingsTab, string][] = [
    ["basic", "生成设置"],
    ["advanced", "高级"],
  ];

  return (
    <div className={className}>
      <div className="mb-4 grid grid-cols-2 gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1">
        {tabs.map(([tab, label]) => (
          <button
            key={tab}
            type="button"
            onClick={() => onChange(tab)}
            className={`h-9 rounded-lg text-sm font-semibold transition-colors ${
              value === tab ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500 hover:text-slate-900"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {value === "basic" ? basic : advanced}
    </div>
  );
}
