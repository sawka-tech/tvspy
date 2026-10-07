import { X } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';

/** A modal built on <dialog>: focus trapping, Escape and the backdrop come from the browser. */
export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a backdrop click is a mouse shortcut; Escape and the Close button cover the keyboard
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-labelledby="dialog-title"
      className="m-auto w-[min(40rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-0 text-ink shadow-xl"
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 id="dialog-title" className="text-sm font-semibold">
          {title}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-ink-2 hover:bg-surface-2 hover:text-ink"
          aria-label="Close"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <div className="max-h-[70vh] overflow-y-auto p-4">{children}</div>
    </dialog>
  );
}
