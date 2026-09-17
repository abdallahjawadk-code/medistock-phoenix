/**
 * Annual Needs — Simple Mode file surface (owner task section 13).
 *
 * A large drag-and-drop / click-to-choose surface around the SAME
 * `<input type="file">` the Advanced upload panel uses, feeding the SAME
 * `onPickFile` handler the parent screen passes down. Picking a file here
 * triggers exactly what it triggers in Advanced Mode: the browser-side
 * PROVISIONAL preview. Nothing is uploaded, persisted or verified until the
 * human presses the explicit upload action rendered by the workspace.
 *
 * The only state in this file is whether a drag is currently hovering the
 * surface — a visual highlight, nothing else.
 */
import { useId, useRef, useState, type DragEvent } from 'react';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';

/** Same accept list as the Advanced upload panel. */
export const SIMPLE_ACCEPT = '.xlsx,.xls,.csv,.zip';

interface Props {
  lang: 'ar' | 'en';
  /** The provisionally parsed file, if one has been picked. */
  pendingFile: File | null;
  /** True once the browser-side preview finished and the upload action may be offered. */
  previewReady: boolean;
  disabled: boolean;
  onPickFile: (file: File | null) => void;
}

export function SimpleUploadZone({ lang, pendingFile, previewReady, disabled, onPickFile }: Props) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    const file = event.dataTransfer.files?.[0] ?? null;
    if (file) onPickFile(file);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (!disabled && !dragging) setDragging(true);
  }

  return (
    <div
      className="cn2b-simple-dropzone"
      data-dragging={dragging}
      data-disabled={disabled}
      data-has-file={pendingFile !== null}
      data-testid="cn2b-simple-dropzone"
      onDragOver={onDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        className="cn2b-simple-dropzone__input"
        accept={SIMPLE_ACCEPT}
        disabled={disabled}
        data-testid="cn2b-simple-file-input"
        onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
      />

      {pendingFile === null ? (
        <label htmlFor={inputId} className="cn2b-simple-dropzone__target">
          <span className="cn2b-simple-dropzone__icon" aria-hidden="true">
            <PhoenixIcon name="file" size={30} />
          </span>
          <span className="cn2b-simple-dropzone__title">{t('cn2b_simple_upload_hint', lang)}</span>
          <span className="cn2b-simple-dropzone__types">{t('cn2b_simple_upload_types', lang)}</span>
        </label>
      ) : (
        <div className="cn2b-simple-dropzone__picked" data-testid="cn2b-simple-picked-file">
          <span className="cn2b-simple-dropzone__icon" data-ready={previewReady} aria-hidden="true">
            <PhoenixIcon name={previewReady ? 'check' : 'file'} size={26} />
          </span>
          <span className="cn2b-simple-dropzone__picked-text">
            <span className="cn2b-simple-dropzone__picked-label">
              {previewReady ? t('cn2b_simple_upload_ready', lang) : t('cn2b_simple_upload_selected', lang)}
            </span>
            <span className="cn2b-simple-dropzone__filename" data-testid="cn2b-simple-picked-filename">
              <bdi>{pendingFile.name}</bdi>
            </span>
          </span>
          <PhoenixButton
            type="button" variant="ghost" size="sm" disabled={disabled}
            onClick={() => { onPickFile(null); if (inputRef.current) inputRef.current.value = ''; inputRef.current?.click(); }}
          >
            {t('cn2b_simple_upload_change', lang)}
          </PhoenixButton>
        </div>
      )}
    </div>
  );
}
