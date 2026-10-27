import type { KeyboardEvent } from 'react';

interface WorkspaceTabsProps<T extends string> {
  id: string;
  label: string;
  items: readonly { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}

export function WorkspaceTabs<T extends string>({
  id, label, items, value, onChange, className = '',
}: WorkspaceTabsProps<T>) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = items.findIndex((item) => item.id === value);
    const next = event.key === 'ArrowRight' ? (index + 1) % items.length
      : event.key === 'ArrowLeft' ? (index - 1 + items.length) % items.length
        : event.key === 'Home' ? 0
          : event.key === 'End' ? items.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    onChange(items[next].id);
    document.getElementById(`${id}-tab-${items[next].id}`)?.focus();
  }

  return (
    <div className={`workspace-tabs ${className}`} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          id={`${id}-tab-${item.id}`}
          aria-controls={`${id}-panel-${item.id}`}
          aria-selected={value === item.id}
          tabIndex={value === item.id ? 0 : -1}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
