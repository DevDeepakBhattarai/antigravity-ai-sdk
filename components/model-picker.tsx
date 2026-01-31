"use client";

import { AVAILABLE_MODELS } from "@/lib/antigravity/constants";

interface ModelPickerProps {
  value: string;
  onChange: (model: string) => void;
}

export function ModelPicker({ value, onChange }: ModelPickerProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 outline-none focus:border-zinc-500"
    >
      {AVAILABLE_MODELS.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
    </select>
  );
}
