"use client";

//
// DatasourcesProvider + hooks (task 5.2).
//
// A React Context + `useReducer` state machine for the datasources dashboard.
// Decision 5 of design.md rejects state libraries (Zustand/Jotai/Redux) — we
// stick with plain React primitives so the dependency graph stays small and
// typed end-to-end.
//
// State machine shapes:
//   - `loading`   — initial fetch in flight, no data yet
//   - `empty`     — fetch resolved with `datasources: []`
//   - `populated` — fetch resolved with at least one summary
//   - `error`     — fetch rejected; we surface the error message
//
// Mutation hooks (`add`, `remove`, `action`, `upload`) are thin passthroughs
// to `window.api.datasources.*` with optimistic local reconciliation on
// success. Errors bubble through the returned promise so callers can toast /
// surface them; the store only updates on successful responses.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import type {
  DatasourcesActionRequest,
  DatasourcesActionResponse,
  DatasourcesAddRequest,
  DatasourcesAddResponse,
  DatasourcesRemoveRequest,
  DatasourcesRemoveResponse,
  DatasourcesUploadRequest,
  DatasourcesUploadResponse,
  DatasourceSummary,
} from "@ft5/ipc-contracts";

export type DatasourcesState =
  | { phase: "loading" }
  | { phase: "empty" }
  | { phase: "populated"; datasources: DatasourceSummary[] }
  | { phase: "error"; error: string };

type Action =
  | { type: "load/start" }
  | { type: "load/success"; datasources: DatasourceSummary[] }
  | { type: "load/failure"; error: string }
  | { type: "datasource/added"; datasource: DatasourceSummary }
  | { type: "datasource/removed"; datasourceId: string }
  | { type: "datasource/updated"; datasource: DatasourceSummary };

function reducer(state: DatasourcesState, action: Action): DatasourcesState {
  switch (action.type) {
    case "load/start":
      return { phase: "loading" };
    case "load/success":
      return action.datasources.length === 0
        ? { phase: "empty" }
        : { phase: "populated", datasources: action.datasources };
    case "load/failure":
      return { phase: "error", error: action.error };
    case "datasource/added": {
      if (state.phase === "populated") {
        return {
          phase: "populated",
          datasources: [...state.datasources, action.datasource],
        };
      }
      // From empty/loading/error, adding one summary makes us populated.
      return { phase: "populated", datasources: [action.datasource] };
    }
    case "datasource/removed": {
      if (state.phase !== "populated") return state;
      const next = state.datasources.filter(
        (d) => d.id !== action.datasourceId,
      );
      return next.length === 0
        ? { phase: "empty" }
        : { phase: "populated", datasources: next };
    }
    case "datasource/updated": {
      if (state.phase !== "populated") return state;
      return {
        phase: "populated",
        datasources: state.datasources.map((d) =>
          d.id === action.datasource.id ? action.datasource : d,
        ),
      };
    }
    default:
      return state;
  }
}

export interface DatasourceActions {
  refresh: () => Promise<void>;
  add: (req: DatasourcesAddRequest) => Promise<DatasourcesAddResponse>;
  remove: (
    req: DatasourcesRemoveRequest,
  ) => Promise<DatasourcesRemoveResponse>;
  action: (
    req: DatasourcesActionRequest,
  ) => Promise<DatasourcesActionResponse>;
  upload: (req: DatasourcesUploadRequest) => Promise<DatasourcesUploadResponse>;
}

interface DatasourcesContextValue {
  state: DatasourcesState;
  actions: DatasourceActions;
}

const DatasourcesContext = createContext<DatasourcesContextValue | null>(null);

export interface DatasourcesProviderProps {
  children: ReactNode;
}

export function DatasourcesProvider({ children }: DatasourcesProviderProps) {
  const [state, dispatch] = useReducer(reducer, {
    phase: "loading",
  } as DatasourcesState);

  // Mount sentinel: gates every post-await dispatch so we do not call
  // `setState` on an unmounted provider (React 19 strict-mode double-mount
  // can otherwise race two in-flight `list()` calls). Mutation callers still
  // receive the resolved response — only local reconciliation is skipped.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    dispatch({ type: "load/start" });
    try {
      const response = await window.api.datasources.list();
      if (!mountedRef.current) return;
      dispatch({
        type: "load/success",
        datasources: response.datasources,
      });
    } catch (err) {
      if (!mountedRef.current) return;
      const message =
        err instanceof Error ? err.message : "Failed to load datasources.";
      dispatch({ type: "load/failure", error: message });
    }
  }, []);

  const add = useCallback(
    async (req: DatasourcesAddRequest): Promise<DatasourcesAddResponse> => {
      const response = await window.api.datasources.add(req);
      if (mountedRef.current) {
        dispatch({
          type: "datasource/added",
          datasource: response.datasource,
        });
      }
      return response;
    },
    [],
  );

  const remove = useCallback(
    async (
      req: DatasourcesRemoveRequest,
    ): Promise<DatasourcesRemoveResponse> => {
      const response = await window.api.datasources.remove(req);
      if (mountedRef.current) {
        dispatch({
          type: "datasource/removed",
          datasourceId: req.datasourceId,
        });
      }
      return response;
    },
    [],
  );

  const action = useCallback(
    async (
      req: DatasourcesActionRequest,
    ): Promise<DatasourcesActionResponse> => {
      const response = await window.api.datasources.action(req);
      if (mountedRef.current) {
        dispatch({
          type: "datasource/updated",
          datasource: response.datasource,
        });
      }
      return response;
    },
    [],
  );

  const upload = useCallback(
    async (
      req: DatasourcesUploadRequest,
    ): Promise<DatasourcesUploadResponse> => {
      // Upload returns a transactionId; progress handling is a later phase.
      // We do NOT mutate local state here — the card's `lastSyncAt` etc. only
      // changes when a subsequent `action` / `list` resolves with new data.
      return window.api.datasources.upload(req);
    },
    [],
  );

  // Initial load on mount.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const actions = useMemo<DatasourceActions>(
    () => ({ refresh, add, remove, action, upload }),
    [refresh, add, remove, action, upload],
  );

  const value = useMemo<DatasourcesContextValue>(
    () => ({ state, actions }),
    [state, actions],
  );

  return (
    <DatasourcesContext.Provider value={value}>
      {children}
    </DatasourcesContext.Provider>
  );
}

export function useDatasources(): DatasourcesState {
  const ctx = useContext(DatasourcesContext);
  if (ctx === null) {
    throw new Error(
      "useDatasources must be used within a <DatasourcesProvider>.",
    );
  }
  return ctx.state;
}

export function useDatasourceActions(): DatasourceActions {
  const ctx = useContext(DatasourcesContext);
  if (ctx === null) {
    throw new Error(
      "useDatasourceActions must be used within a <DatasourcesProvider>.",
    );
  }
  return ctx.actions;
}
