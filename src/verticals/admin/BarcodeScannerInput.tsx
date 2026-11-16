'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isValidEan13, normaliseBarcode } from './barcode';
import { WedgeDetector } from './scanner';

/**
 * A barcode field for a USB wedge scanner.
 *
 * A wedge scanner types the barcode as fast keystrokes and ends with Enter. This input focuses on
 * mount, keeps focus, and treats a fast burst of digits ending in Enter as one scan: the burst is
 * buffered and validated when Enter arrives. A human typing slowly is left alone (the buffer resets
 * after a pause), so a manual entry still works.
 *
 * A 13-digit value must satisfy the EAN-13 check digit; the field shows a green tick when it does
 * and a red hint when it does not, and calls `onSave` only with a valid value.
 */


export interface BarcodeScannerInputProps {
  onSave: (barcode: string | null) => void;
  value?: string | null;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Test seam: overrides the clock the wedge detector uses. */
  now?: () => number;
}

export function BarcodeScannerInput({
  onSave,
  value,
  placeholder = 'Scan or type a barcode',
  disabled = false,
  autoFocus = true,
  now = () => Date.now(),
}: BarcodeScannerInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(value ?? '');
  const [flash, setFlash] = useState(false);
  const detector = useMemo(() => new WedgeDetector({ now }), [now]);

  useEffect(() => {
    if (autoFocus && inputRef.current) inputRef.current.focus();
  }, [autoFocus]);

  useEffect(() => {
    setText(value ?? '');
  }, [value]);

  const valid = text.trim() === '' ? null : isValidEan13(text);

  const commit = useCallback(
    (raw: string) => {
      const barcode = normaliseBarcode(raw);
      if (barcode !== null && !isValidEan13(barcode)) return;
      onSave(barcode);
      setText(barcode ?? '');
      if (barcode !== null) {
        setFlash(true);
        window.setTimeout(() => setFlash(false), 600);
      }
    },
    [onSave],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        // A fast burst ending in Enter is a scan; the whole burst is one value.
        commit(detector.enter(text));
        return;
      }
      if (event.key.length === 1 && /[0-9A-Za-z]/.test(event.key)) {
        detector.key(event.key);
      }
    },
    [commit, detector, text],
  );

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <input
        ref={inputRef}
        data-testid="barcode-scanner-input"
        aria-label="Barcode"
        placeholder={placeholder}
        value={text}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (autoFocus && inputRef.current) inputRef.current.focus();
        }}
        style={{ padding: '4px 8px' }}
      />
      {valid === true && (
        <span data-testid="barcode-valid" title="Valid EAN-13" style={{ color: '#1a7f37' }}>
          {flash ? '✓ scanned' : '✓'}
        </span>
      )}
      {valid === false && (
        <span data-testid="barcode-invalid" title="Invalid EAN-13 check digit" style={{ color: '#c0392b' }}>
          invalid check digit
        </span>
      )}
    </span>
  );
}
