import { useCallback, useEffect, useRef } from 'react';
import './FileEditorBody.css';

interface FileEditorBodyProps {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  label: string;
}

export function FileEditorBody({ value, onChange, disabled, label }: FileEditorBodyProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaretRef = useRef<number | null>(null);

  useEffect(() => {
    const caret = pendingCaretRef.current;
    const textarea = textareaRef.current;
    if (caret === null || !textarea?.isConnected) return;
    textarea.selectionStart = caret;
    textarea.selectionEnd = caret;
    pendingCaretRef.current = null;
  }, [value]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    const target = event.currentTarget;
    const start = target.selectionStart;
    const end = target.selectionEnd;
    const next = `${value.slice(0, start)}  ${value.slice(end)}`;
    pendingCaretRef.current = start + 2;
    onChange(next);
  }, [onChange, value]);

  return (
    <div className="file-editor-body">
      <textarea
        ref={textareaRef}
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
