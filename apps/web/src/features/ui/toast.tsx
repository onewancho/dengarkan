"use client";

// ============================================
// DENGARKAN — UI Feature: Toast Notifications
//
// Accessible, lightweight, glassmorphic toast system.
// Used for optimistic rollback alerts and system notifications.
// ============================================

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";

export type ToastType = "error" | "success" | "info" | "warning";

export interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastType, durationMs?: number) => void;
  dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timeoutsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

  const dismissToast = useCallback((id: string) => {
    const timeout = timeoutsRef.current.get(id);
    if (timeout) {
      clearTimeout(timeout);
      timeoutsRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, type: ToastType = "info", durationMs = 3500) => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      setToasts((prev) => [...prev, { id, message, type }]);

      const timeout = setTimeout(() => {
        dismissToast(id);
      }, durationMs);

      timeoutsRef.current.set(id, timeout);
    },
    [dismissToast]
  );

  return (
    <ToastContext.Provider value={{ showToast, dismissToast }}>
      {children}

      {/* Floating Toast Container */}
      <div
        className="fixed top-4 inset-x-0 z-50 flex flex-col items-center pointer-events-none px-4 gap-2"
        role="region"
        aria-label="Notifications"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="alert"
            aria-live="assertive"
            className={`pointer-events-auto max-w-md w-full glass rounded-2xl p-3.5 shadow-2xl border flex items-center gap-3 transition-all duration-300 animate-in fade-in slide-in-from-top-4 ${
              toast.type === "error"
                ? "border-error/40 bg-error/15 text-text-primary"
                : toast.type === "success"
                ? "border-success/40 bg-success/15 text-text-primary"
                : toast.type === "warning"
                ? "border-warning/40 bg-warning/15 text-text-primary"
                : "border-brand-500/30 bg-surface-2/90 text-text-primary"
            }`}
          >
            {/* Status icon */}
            <div className="flex-shrink-0">
              {toast.type === "error" && (
                <div className="w-6 h-6 rounded-full bg-error/20 flex items-center justify-center text-error">
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </div>
              )}
              {toast.type === "success" && (
                <div className="w-6 h-6 rounded-full bg-success/20 flex items-center justify-center text-success">
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
              )}
              {toast.type === "warning" && (
                <div className="w-6 h-6 rounded-full bg-warning/20 flex items-center justify-center text-warning">
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                </div>
              )}
              {toast.type === "info" && (
                <div className="w-6 h-6 rounded-full bg-brand-500/20 flex items-center justify-center text-brand-300">
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="16" x2="12" y2="12" />
                    <line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                </div>
              )}
            </div>

            {/* Message */}
            <p className="flex-1 text-xs sm:text-sm font-medium leading-snug">
              {toast.message}
            </p>

            {/* Dismiss button */}
            <button
              onClick={() => dismissToast(toast.id)}
              className="flex-shrink-0 p-1 rounded-lg text-text-muted hover:text-text-primary hover:bg-white/10 transition-default"
              aria-label="Dismiss notification"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Fallback if rendered outside provider (e.g. tests or isolated hooks)
    return {
      showToast: (msg: string, type?: ToastType) => {
        if (type === "error") console.error(`[Toast Error]: ${msg}`);
        else console.log(`[Toast ${type}]: ${msg}`);
      },
      dismissToast: () => {},
    };
  }
  return ctx;
}
