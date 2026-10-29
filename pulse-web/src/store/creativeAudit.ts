import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface CreativeAuditState {
  /** Current audit result (persisted across page navigation) */
  audit: any | null;
  /** nmId of the audited product */
  selectedNmId: string;
  /** Active V3 sub-tab */
  v3Tab: string;

  /** Hydration flag — true once state has been restored from storage */
  _hasHydrated: boolean;

  setAudit: (audit: any | null) => void;
  setSelectedNmId: (nmId: string) => void;
  setV3Tab: (tab: string) => void;
  setHasHydrated: (v: boolean) => void;
  clear: () => void;
}

export const useCreativeAuditStore = create<CreativeAuditState>()(
  persist(
    (set) => ({
      audit: null,
      selectedNmId: '',
      v3Tab: 'overview',
      _hasHydrated: false,

      setAudit: (audit) => set({ audit }),
      setSelectedNmId: (selectedNmId) => set({ selectedNmId }),
      setV3Tab: (v3Tab) => set({ v3Tab }),
      setHasHydrated: (v) => set({ _hasHydrated: v }),
      clear: () => set({ audit: null, selectedNmId: '', v3Tab: 'overview' }),
    }),
    {
      name: 'pulse-creative-audit',
      // Use sessionStorage — survives SPA navigation, no 5MB limit issues
      storage: createJSONStorage(() =>
        typeof window !== 'undefined' ? sessionStorage : {
          getItem: () => null,
          setItem: () => {},
          removeItem: () => {},
        }
      ),
      partialize: (state) => ({
        audit: state.audit,
        selectedNmId: state.selectedNmId,
        v3Tab: state.v3Tab,
      }),
      onRehydrateStorage: () => {
        return (_state, error) => {
          if (error) {
            console.warn('Creative audit store rehydration failed:', error);
          }
          // Mark hydration complete regardless of success/failure.
          // Defer to the next tick: rehydration runs synchronously inside create(),
          // so useCreativeAuditStore is in TDZ at this point. setTimeout(0) waits
          // until the binding is assigned.
          setTimeout(() => {
            useCreativeAuditStore.setState({ _hasHydrated: true });
          }, 0);
        };
      },
    }
  )
);
