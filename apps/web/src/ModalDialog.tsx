import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

interface ModalDialogProps {
  readonly className: string;
  readonly describedBy?: string;
  readonly labelledBy: string;
  readonly onClose: () => void;
  readonly role?: "alertdialog" | "dialog";
  readonly children: ReactNode;
}

export function ModalDialog({
  className,
  describedBy,
  labelledBy,
  onClose,
  role = "dialog",
  children,
}: ModalDialogProps): React.JSX.Element {
  const dialogRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const dialog = dialogRef.current;
    if (dialog === null) {
      throw new Error("A modal dialog must render its dialog element.");
    }
    (focusableElements(dialog)[0] ?? dialog).focus();
    return () => returnFocus?.focus();
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const elements = focusableElements(dialog);
    const first = elements[0];
    const last = elements.at(-1);
    if (first === undefined || last === undefined) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <section
      ref={dialogRef}
      className={className}
      role={role}
      aria-modal="true"
      aria-describedby={describedBy}
      aria-labelledby={labelledBy}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      {children}
    </section>
  );
}

function focusableElements(container: HTMLElement): readonly HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(focusableSelector)].filter(
    (element) => element.getClientRects().length > 0,
  );
}
