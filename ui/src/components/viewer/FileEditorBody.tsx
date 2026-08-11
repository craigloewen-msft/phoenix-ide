import { useCallback } from 'react';
import './FileEditorBody.css';

interface FileEditorBodyProps {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  label: string;
}

export function FileEditorBody({ value, onChange, disabled, label }: FileEditorBodyProps) {
  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    const target = event.currentTarget;
    const start = target.selectionStart;
    const end = target.selectionEnd;
    const next = `${value.slice(0, start)}  ${value.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => {
      target.selectionStart = start + 2;
      target.selectionEnd = start + 2;
    });
  }, [onChange, value]);

  return (
    <div className="file-editor-body">
      <textarea
        className="file-editor-input"
        aria-label={label}
        value={value}
        disabled={disabled}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
}
