// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type PropsWithChildren } from "react";
import { describe, expect, it } from "vitest";

import { ControllerStateProvider } from "./controller-state-provider.js";
import {
  ControllerStateCoordinator,
  type ControllerEventStream,
  type ControllerEventStreamHandlers,
} from "./controller-state-coordinator.js";
import { createTestControllerSnapshot } from "./test-controller-snapshot.js";
import { useControllerState } from "./use-controller-state.js";

class ProviderTestEventStream implements ControllerEventStream {
  handlers: ControllerEventStreamHandlers | null = null;
  closed = false;

  listen(handlers: ControllerEventStreamHandlers): void {
    this.handlers = handlers;
  }

  close(): void {
    this.closed = true;
  }
}

describe("ControllerStateProvider", () => {
  it("shares one coordinator state and tears down its stream on unmount", async () => {
    const stream = new ProviderTestEventStream();
    const coordinator = new ControllerStateCoordinator({
      fetchSnapshot: async () => createTestControllerSnapshot(3),
      createEventStream: () => stream,
    });
    const wrapper = ({ children }: PropsWithChildren): React.JSX.Element =>
      createElement(ControllerStateProvider, { coordinator, children });

    const { result, unmount } = renderHook(() => useControllerState(), {
      wrapper,
    });
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(3));

    act(() => {
      stream.handlers?.message(
        JSON.stringify({
          type: "system.stream-ready",
          occurredAt: "2026-07-13T10:00:00.000Z",
          data: { currentRevision: 3, replayedCount: 0 },
        }),
      );
    });
    expect(result.current.status).toBe("connected");

    unmount();
    expect(stream.closed).toBe(true);
  });
});
