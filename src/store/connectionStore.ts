import { create } from "zustand";
import * as api from "../api";
import type { ConnectionConfig, ConnectionHandle, ConnectionProfile } from "../types";
import { DB_META } from "../types";
import { useUiStore } from "./uiStore";

export interface ActiveConnection {
  handle: ConnectionHandle;
  name: string;
  /** 이 연결이 특정 저장 프로필에서 왔으면 그 id. 임시 연결이면 undefined. */
  profileId?: string;
}

interface ConnectionState {
  profiles: ConnectionProfile[];
  /** connId -> 활성 연결 */
  connections: Record<string, ActiveConnection>;
  loadProfiles: () => Promise<void>;
  saveProfile: (profile: ConnectionProfile, password?: string | null) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  connectProfile: (id: string, password?: string | null) => Promise<string | null>;
  connectAdhoc: (config: ConnectionConfig, name: string) => Promise<string | null>;
  disconnect: (connId: string) => Promise<void>;
}

export const useConnectionStore = create<ConnectionState>()((set, get) => ({
  profiles: [],
  connections: {},

  loadProfiles: async () => {
    try {
      set({ profiles: await api.listProfiles() });
    } catch (e) {
      useUiStore.getState().toastError(e, "프로필 로드 실패");
    }
  },

  saveProfile: async (profile, password) => {
    await api.saveProfile(profile, password);
    await get().loadProfiles();
  },

  deleteProfile: async (id) => {
    try {
      await api.deleteProfile(id);
      await get().loadProfiles();
    } catch (e) {
      useUiStore.getState().toastError(e, "프로필 삭제 실패");
    }
  },

  connectProfile: async (id, password) => {
    const ui = useUiStore.getState();
    const profile = get().profiles.find((p) => p.id === id);
    ui.setStatus(`${profile?.name ?? id} 연결 중…`);
    try {
      const handle = await api.connectProfile(id, password);
      set((s) => ({
        connections: {
          ...s.connections,
          [handle.connId]: { handle, name: profile?.name ?? id, profileId: id },
        },
      }));
      ui.setStatus(`${profile?.name ?? id} 연결됨`);
      return handle.connId;
    } catch (e) {
      ui.toastError(e, "연결 실패");
      return null;
    }
  },

  connectAdhoc: async (config, name) => {
    const ui = useUiStore.getState();
    ui.setStatus(`${name} 연결 중…`);
    try {
      const handle = await api.connect(config);
      set((s) => ({
        connections: { ...s.connections, [handle.connId]: { handle, name } },
      }));
      ui.setStatus(`${name} 연결됨`);
      return handle.connId;
    } catch (e) {
      ui.toastError(e, "연결 실패");
      return null;
    }
  },

  disconnect: async (connId) => {
    try {
      await api.disconnect(connId);
    } catch {
      // 연결이 이미 끊겼을 수 있음 — 무시.
    }
    set((s) => {
      const next = { ...s.connections };
      delete next[connId];
      return { connections: next };
    });
  },
}));

/** DB 종류의 기본 포트를 돌려준다. */
export function defaultPort(kind: ConnectionProfile["kind"]): number | undefined {
  return DB_META[kind].defaultPort;
}

/** 프로필 id 로 활성 연결의 connId 를 찾는다(없으면 null). */
export function connIdForProfile(
  connections: Record<string, ActiveConnection>,
  profileId: string,
): string | null {
  const found = Object.values(connections).find((c) => c.profileId === profileId);
  return found ? found.handle.connId : null;
}
