import { useRef, type PointerEvent, type ReactNode } from "react";

interface ModalBackdropProps {
  readonly className?: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

export function ModalBackdrop({
  className = "modal-backdrop",
  onClose,
  children,
}: ModalBackdropProps): React.JSX.Element {
  const pressedBackdrop = useRef(false);

  function handlePointerDown(event: PointerEvent<HTMLDivElement>): void {
    pressedBackdrop.current = event.target === event.currentTarget;
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>): void {
    const close =
      pressedBackdrop.current && event.target === event.currentTarget;
    pressedBackdrop.current = false;
    if (close) onClose();
  }

  return (
    <div
      className={className}
      role="presentation"
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => {
        pressedBackdrop.current = false;
      }}
    >
      {children}
    </div>
  );
}
